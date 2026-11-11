import { z } from "zod";
import { SafeError } from "../errors.ts";
import type { Attempt, Jmap } from "../jmap/client.ts";
import { tool } from "./define.ts";
import { requireRole } from "./mail-write.ts";
import { entry, expect, getList, id } from "./schema.ts";
import { created, single } from "./set.ts";

const recipient = z.object({
  email: z.email().max(320),
  name: z.string().max(200).optional(),
});
const recipients = z.array(recipient).max(50);
const compose = {
  to: recipients.min(1),
  cc: recipients.optional(),
  bcc: recipients.optional(),
  subject: z.string().max(998).optional(),
  text_body: z.string().max(1_000_000),
  identity_id: id.optional(),
  reply_to_email_id: id.optional(),
};
type Compose = z.infer<z.ZodObject<typeof compose>>;
// A reply takes its subject from the original; anything else needs one.
const hasSubject = (input: Compose) =>
  input.subject !== undefined || input.reply_to_email_id !== undefined;

const mailboxes = z.object({
  list: z.array(
    z.object({ id: z.string(), role: z.string().nullable().optional() }),
  ),
});
const identities = z.object({
  list: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
});
const stored = z.object({
  id: z.string(),
  subject: z.string().nullable().optional(),
  messageId: z.array(z.string()).nullable().optional(),
  references: z.array(z.string()).nullable().optional(),
  mailboxIds: z.record(z.string(), z.boolean()).optional(),
  keywords: z.record(z.string(), z.boolean()).optional(),
  from: z
    .array(z.object({ email: z.string().nullable() }))
    .nullable()
    .optional(),
});

/** Everything a draft or send needs to know before writing, in one read. */
async function prepare(jmap: Jmap, signal: AbortSignal, emailIds: string[]) {
  const [boxes, who, emails] = await jmap.call(
    ["mail", "submission"],
    [
      ["Mailbox/get", { ids: null, properties: ["role"] }],
      ["Identity/get", { ids: null }],
      [
        "Email/get",
        {
          ids: emailIds,
          properties: [
            "subject",
            "messageId",
            "references",
            "mailboxIds",
            "keywords",
            "from",
          ],
        },
      ],
    ],
    signal,
  );
  const roles = new Map<string, string>();
  for (const box of expect(mailboxes, boxes).list)
    if (box.role) roles.set(box.role, box.id);
  const { list } = expect(getList, emails);
  return {
    drafts: requireRole(roles, "drafts"),
    sent: requireRole(roles, "sent"),
    identities: expect(identities, who).list,
    email(emailId: string) {
      const found = entry(list, emailId);
      if (!found) throw new SafeError("NOT_FOUND");
      return expect(stored, found);
    },
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;

function identityFor(
  prepared: Prepared,
  wanted: string | undefined,
  fromEmail?: string | null,
) {
  if (wanted) {
    const found = prepared.identities.find(
      (identity) => identity.id === wanted,
    );
    if (!found) throw new SafeError("NOT_FOUND");
    return found;
  }
  const found =
    prepared.identities.find(
      (identity) => fromEmail && identity.email === fromEmail,
    ) ?? prepared.identities[0];
  if (!found) throw new SafeError("UPSTREAM_CHANGED");
  return found;
}

/** A draft in the Drafts mailbox, or NOT_A_DRAFT. */
function requireDraft(prepared: Prepared, emailId: string) {
  const email = prepared.email(emailId);
  if (!email.keywords?.$draft || !email.mailboxIds?.[prepared.drafts])
    throw new SafeError("NOT_A_DRAFT");
  return email;
}

function draftBody(prepared: Prepared, input: Compose) {
  const identity = identityFor(prepared, input.identity_id);
  const original = input.reply_to_email_id
    ? prepared.email(input.reply_to_email_id)
    : undefined;
  const parent = original?.messageId?.[0];
  const subject =
    input.subject ??
    (/^re:/i.test(original?.subject ?? "")
      ? original!.subject!
      : `Re: ${original?.subject ?? ""}`.trimEnd());
  const people = (list: z.infer<typeof recipients> | undefined) =>
    (list ?? []).map((person) => ({
      name: person.name ?? null,
      email: person.email,
    }));
  return {
    identity,
    email: {
      mailboxIds: { [prepared.drafts]: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: identity.name, email: identity.email }],
      to: people(input.to),
      cc: people(input.cc),
      bcc: people(input.bcc),
      subject,
      ...(parent
        ? {
            inReplyTo: [parent],
            references: [...(original?.references ?? []), parent],
          }
        : {}),
      textBody: [{ partId: "body", type: "text/plain" }],
      bodyValues: { body: { value: input.text_body } },
    },
  };
}

const replyNote =
  "With reply_to_email_id the draft threads under that email and takes 'Re: <subject>' unless subject is given.";

export const createDraft = tool({
  name: "pim_create_draft",
  group: "draft",
  description: `Save a new plain-text draft in the Drafts mailbox; nothing is sent. From is the identity (identity_id, default the first from pim_list_identities). ${replyNote} Not idempotent: on WRITE_OUTCOME_UNKNOWN, search Drafts before retrying.`,
  input: compose,
  check: hasSubject,
  async run(input, { jmap, signal, attempt }) {
    const prepared = await prepare(
      jmap,
      signal,
      input.reply_to_email_id ? [input.reply_to_email_id] : [],
    );
    const { email } = draftBody(prepared, input);
    const [result] = await jmap.call(
      ["mail"],
      [["Email/set", { create: { draft: email } }]],
      signal,
      { attempt },
    );
    return { email_id: created(result, "draft") };
  },
});

export const updateDraft = tool({
  name: "pim_update_draft",
  group: "draft",
  description: `Replace a draft's whole content (recipients, subject, body). Emails cannot be edited in place, so the server stores a new draft and deletes the old one: use the returned email_id from now on. Only drafts in the Drafts mailbox are accepted. ${replyNote}`,
  input: { email_id: id, ...compose },
  check: hasSubject,
  async run(input, { jmap, signal, attempt }) {
    const ids = [
      input.email_id,
      ...(input.reply_to_email_id ? [input.reply_to_email_id] : []),
    ];
    const prepared = await prepare(jmap, signal, ids);
    requireDraft(prepared, input.email_id);
    const { email } = draftBody(prepared, input);
    const [result] = await jmap.call(
      ["mail"],
      [["Email/set", { create: { draft: email }, destroy: [input.email_id] }]],
      signal,
      { attempt },
    );
    const emailId = created(result, "draft");
    single(result, "destroyed", input.email_id);
    return { email_id: emailId, replaced: input.email_id };
  },
});

export const deleteDraft = tool({
  name: "pim_delete_draft",
  group: "draft",
  description:
    "Permanently delete a draft. Only drafts in the Drafts mailbox are accepted.",
  input: { email_id: id },
  destructive: true,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    requireDraft(await prepare(jmap, signal, [input.email_id]), input.email_id);
    const [result] = await jmap.call(
      ["mail"],
      [["Email/set", { destroy: [input.email_id] }]],
      signal,
      { attempt },
    );
    single(result, "destroyed", input.email_id);
    return { deleted: input.email_id };
  },
});

/** Submits `emailId` (an ID or a creation reference) and files it in Sent. */
async function submit(
  jmap: Jmap,
  signal: AbortSignal,
  attempt: Attempt,
  prepared: Prepared,
  identityId: string,
  emailId: string,
  create?: Record<string, unknown>,
) {
  const results = await jmap.call(
    ["mail", "submission"],
    [
      ...(create
        ? [
            ["Email/set", { create: { draft: create } }] as [
              string,
              Record<string, unknown>,
            ],
          ]
        : []),
      [
        "EmailSubmission/set",
        {
          create: { send: { identityId, emailId } },
          onSuccessUpdateEmail: {
            "#send": {
              [`mailboxIds/${prepared.drafts}`]: null,
              [`mailboxIds/${prepared.sent}`]: true,
              "keywords/$draft": null,
            },
          },
        },
      ],
    ],
    signal,
    { attempt },
  );
  const draftId = create ? created(results[0], "draft") : emailId;
  return { email_id: draftId, submission_id: created(results.at(-1), "send") };
}

const sendNote =
  "Sends real mail immediately; it cannot be recalled. Not idempotent: on WRITE_OUTCOME_UNKNOWN, check Sent before retrying or it may be sent twice.";

export const sendDraft = tool({
  name: "pim_send_draft",
  group: "send",
  description: `Send an existing draft from the Drafts mailbox and move it to Sent. The identity defaults to the one matching the draft's From. ${sendNote}`,
  input: { email_id: id, identity_id: id.optional() },
  async run(input, { jmap, signal, attempt }) {
    const prepared = await prepare(jmap, signal, [input.email_id]);
    const draft = requireDraft(prepared, input.email_id);
    const identity = identityFor(
      prepared,
      input.identity_id,
      draft.from?.[0]?.email,
    );
    return submit(jmap, signal, attempt, prepared, identity.id, input.email_id);
  },
});

export const sendEmail = tool({
  name: "pim_send_email",
  group: "send",
  description: `Compose a plain-text email and send it in one step; it is stored in Sent. ${replyNote} If the server refuses to send, the message stays in Drafts. ${sendNote}`,
  input: compose,
  check: hasSubject,
  async run(input, { jmap, signal, attempt }) {
    const prepared = await prepare(
      jmap,
      signal,
      input.reply_to_email_id ? [input.reply_to_email_id] : [],
    );
    const { identity, email } = draftBody(prepared, input);
    return submit(
      jmap,
      signal,
      attempt,
      prepared,
      identity.id,
      "#draft",
      email,
    );
  },
});
