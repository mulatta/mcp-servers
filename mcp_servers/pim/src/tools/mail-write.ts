import { z } from "zod";
import { SafeError } from "../errors.ts";
import type { Jmap } from "../jmap/client.ts";
import { tool } from "./define.ts";
import { tagId, tagPrefix } from "./mail.ts";
import { entry, expect, getList, id, trueKeys } from "./schema.ts";
import { created, outcome, single } from "./set.ts";

const emailIds = z
  .array(id)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "IDs must be unique");
const tags = z.array(tagId).min(1).max(20).optional();

const mailboxRoles = z.object({
  list: z.array(
    z.object({ id: z.string(), role: z.string().nullable().optional() }),
  ),
});

/** Mailbox IDs by role (inbox, drafts, sent, trash, junk, archive). */
export async function roles(jmap: Jmap, signal: AbortSignal) {
  const [result] = await jmap.call(
    ["mail"],
    [["Mailbox/get", { ids: null, properties: ["role"] }]],
    signal,
  );
  const byRole = new Map<string, string>();
  for (const box of expect(mailboxRoles, result).list)
    if (box.role) byRole.set(box.role, box.id);
  return byRole;
}

export function requireRole(byRole: Map<string, string>, role: string) {
  const found = byRole.get(role);
  if (!found) throw new SafeError("UPSTREAM_CHANGED");
  return found;
}

const patchAll = (ids: string[], patch: Record<string, unknown>) =>
  Object.fromEntries(ids.map((emailId) => [emailId, patch]));

export const setEmailFlags = tool({
  name: "pim_set_email_flags",
  group: "flag",
  description:
    "Mark up to 100 emails read or unread (seen), flagged or not (flagged), and add or remove Bulwark tags by tag ID. Only the given fields change. Returns the email IDs the server confirmed and any it refused.",
  input: {
    email_ids: emailIds,
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
    add_tags: tags,
    remove_tags: tags,
  },
  check: (input) =>
    input.seen !== undefined ||
    input.flagged !== undefined ||
    input.add_tags !== undefined ||
    input.remove_tags !== undefined,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const patch: Record<string, true | null> = {};
    if (input.seen !== undefined) patch["keywords/$seen"] = input.seen || null;
    if (input.flagged !== undefined)
      patch["keywords/$flagged"] = input.flagged || null;
    for (const tag of input.add_tags ?? [])
      patch[`keywords/${tagPrefix}${tag}`] = true;
    for (const tag of input.remove_tags ?? [])
      patch[`keywords/${tagPrefix}${tag}`] = null;
    const [result] = await jmap.call(
      ["mail"],
      [["Email/set", { update: patchAll(input.email_ids, patch) }]],
      signal,
      { attempt },
    );
    const { done, failed } = outcome(result, "updated", input.email_ids);
    return { updated: done, failed };
  },
});

async function patchEmails(
  name: "moved" | "updated" | "trashed",
  ids: string[],
  patch: Record<string, unknown>,
  {
    jmap,
    signal,
    attempt,
  }: { jmap: Jmap; signal: AbortSignal; attempt: { dispatched: boolean } },
) {
  const [result] = await jmap.call(
    ["mail"],
    [["Email/set", { update: patchAll(ids, patch) }]],
    signal,
    {
      attempt,
    },
  );
  const { done, failed } = outcome(result, "updated", ids);
  return { [name]: done, failed };
}

export const moveEmails = tool({
  name: "pim_move_emails",
  group: "organize",
  description:
    "Move up to 100 emails into one mailbox, taking them out of every other mailbox. To file an email in an extra mailbox while keeping it where it is, use pim_add_emails_to_mailbox.",
  input: { email_ids: emailIds, mailbox_id: id },
  idempotent: true,
  run: (input, context) =>
    patchEmails(
      "moved",
      input.email_ids,
      { mailboxIds: { [input.mailbox_id]: true } },
      context,
    ),
});

export const addEmailsToMailbox = tool({
  name: "pim_add_emails_to_mailbox",
  group: "organize",
  description:
    "Also file up to 100 emails in a mailbox, keeping their other mailboxes (one email can be in several, like labels).",
  input: { email_ids: emailIds, mailbox_id: id },
  idempotent: true,
  run: (input, context) =>
    patchEmails(
      "updated",
      input.email_ids,
      { [`mailboxIds/${input.mailbox_id}`]: true },
      context,
    ),
});

export const removeEmailsFromMailbox = tool({
  name: "pim_remove_emails_from_mailbox",
  group: "organize",
  description:
    "Take up to 100 emails out of one mailbox while they stay in their others. The server refuses for an email that would be left in no mailbox; use pim_move_emails or pim_trash_emails for that.",
  input: { email_ids: emailIds, mailbox_id: id },
  idempotent: true,
  run: (input, context) =>
    patchEmails(
      "updated",
      input.email_ids,
      { [`mailboxIds/${input.mailbox_id}`]: null },
      context,
    ),
});

const mailboxName = z.string().min(1).max(255);

export const createMailbox = tool({
  name: "pim_create_mailbox",
  group: "organize",
  description:
    "Create a mailbox (folder), optionally inside parent_id. Not idempotent: on WRITE_OUTCOME_UNKNOWN, list mailboxes before retrying.",
  input: { name: mailboxName, parent_id: id.optional() },
  async run(input, { jmap, signal, attempt }) {
    const [result] = await jmap.call(
      ["mail"],
      [
        [
          "Mailbox/set",
          {
            create: {
              new: { name: input.name, parentId: input.parent_id ?? null },
            },
          },
        ],
      ],
      signal,
      { attempt },
    );
    return {
      mailbox_id: created(result, "new"),
      name: input.name,
      parent_id: input.parent_id ?? null,
    };
  },
});

export const updateMailbox = tool({
  name: "pim_update_mailbox",
  group: "organize",
  description:
    "Rename a mailbox and/or move it under another parent (parent_id null moves it to the top level).",
  input: {
    mailbox_id: id,
    name: mailboxName.optional(),
    parent_id: id.nullable().optional(),
  },
  check: (input) => input.name !== undefined || input.parent_id !== undefined,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.parent_id !== undefined) patch.parentId = input.parent_id;
    const [result] = await jmap.call(
      ["mail"],
      [["Mailbox/set", { update: { [input.mailbox_id]: patch } }]],
      signal,
      {
        attempt,
      },
    );
    single(result, "updated", input.mailbox_id);
    return { ...input };
  },
});

export const deleteMailbox = tool({
  name: "pim_delete_mailbox",
  group: "organize",
  description:
    "Delete an empty mailbox with no child mailboxes. A mailbox that still holds emails is refused with MAILBOX_NOT_EMPTY; emails are never deleted along with it.",
  input: { mailbox_id: id },
  destructive: true,
  async run(input, { jmap, signal, attempt }) {
    const [result] = await jmap.call(
      ["mail"],
      [
        [
          "Mailbox/set",
          { destroy: [input.mailbox_id], onDestroyRemoveEmails: false },
        ],
      ],
      signal,
      { attempt },
    );
    single(result, "destroyed", input.mailbox_id);
    return { deleted: input.mailbox_id };
  },
});

export const trashEmails = tool({
  name: "pim_trash_emails",
  group: "delete",
  description:
    "Move up to 100 emails to the Trash mailbox, out of all others. They can be moved back until the server purges Trash.",
  input: { email_ids: emailIds },
  idempotent: true,
  async run(input, context) {
    const trash = requireRole(
      await roles(context.jmap, context.signal),
      "trash",
    );
    return patchEmails(
      "trashed",
      input.email_ids,
      { mailboxIds: { [trash]: true } },
      context,
    );
  },
});

const placed = z.object({
  id: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()),
});

export const destroyEmails = tool({
  name: "pim_destroy_emails",
  group: "delete",
  description:
    "Permanently delete up to 100 emails. Only emails that are solely in Trash or Junk are accepted; any other email refuses the whole request with NOT_IN_TRASH before anything is deleted. Cannot be undone.",
  input: { email_ids: emailIds },
  destructive: true,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const byRole = await roles(jmap, signal);
    const disposable = new Set(
      [byRole.get("trash"), byRole.get("junk")].filter(Boolean),
    );
    const [current] = await jmap.call(
      ["mail"],
      [["Email/get", { ids: input.email_ids, properties: ["mailboxIds"] }]],
      signal,
    );
    const { list } = expect(getList, current);
    for (const emailId of input.email_ids) {
      const found = entry(list, emailId);
      if (!found) continue; // The server reports it as not found.
      const boxes = trueKeys(expect(placed, found).mailboxIds);
      if (!boxes.length || boxes.some((box) => !disposable.has(box)))
        throw new SafeError("NOT_IN_TRASH");
    }
    const [result] = await jmap.call(
      ["mail"],
      [["Email/set", { destroy: input.email_ids }]],
      signal,
      { attempt },
    );
    const { done, failed } = outcome(result, "destroyed", input.email_ids);
    return { destroyed: done, failed };
  },
});
