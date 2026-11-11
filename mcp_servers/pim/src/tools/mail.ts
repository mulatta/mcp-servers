import { z } from "zod";
import { SafeError } from "../errors.ts";
import { decodeCursor, nextCursor } from "./cursor.ts";
import { tool } from "./define.ts";
import { expect, getList, id, queryPage, trueKeys, utcDate } from "./schema.ts";
import { htmlToText } from "./text.ts";

/** Bulwark stores its tags as the keyword `$label:<id>`. */
export const tagPrefix = "$label:";
export const tagId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,62}$/);
const systemFlags = {
  seen: "$seen",
  flagged: "$flagged",
  answered: "$answered",
  draft: "$draft",
};

const address = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable(),
});
const addresses = z.array(address).nullable().optional();
export const summaryProperties = [
  "threadId",
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "subject",
  "receivedAt",
  "preview",
  "hasAttachment",
  "size",
];
const emailSummary = z.object({
  id: z.string(),
  threadId: z.string(),
  mailboxIds: z.record(z.string(), z.boolean()),
  keywords: z.record(z.string(), z.boolean()),
  from: addresses,
  to: addresses,
  subject: z.string().nullable(),
  receivedAt: z.string(),
  preview: z.string().optional(),
  hasAttachment: z.boolean(),
  size: z.number().int().nonnegative(),
});

const people = (list: z.infer<typeof addresses>) =>
  (list ?? []).map((entry) => ({
    name: entry.name ?? null,
    email: entry.email,
  }));

export function summarize(value: unknown) {
  const email = expect(emailSummary, value);
  const keywords = Object.keys(email.keywords).filter(
    (key) => email.keywords[key],
  );
  const system = new Set<string>(Object.values(systemFlags));
  return {
    email_id: email.id,
    thread_id: email.threadId,
    mailbox_ids: trueKeys(email.mailboxIds),
    from: people(email.from),
    to: people(email.to),
    subject: email.subject,
    received_at: email.receivedAt,
    preview: email.preview ?? null,
    has_attachment: email.hasAttachment,
    size: email.size,
    flags: {
      seen: keywords.includes(systemFlags.seen),
      flagged: keywords.includes(systemFlags.flagged),
      answered: keywords.includes(systemFlags.answered),
      draft: keywords.includes(systemFlags.draft),
    },
    tags: keywords
      .filter((key) => key.startsWith(tagPrefix))
      .map((key) => key.slice(tagPrefix.length))
      .sort(),
    keywords: keywords
      .filter((key) => !key.startsWith(tagPrefix) && !system.has(key))
      .sort(),
  };
}

const searchInput = {
  mailbox_id: id.optional(),
  text: z.string().min(1).max(500).optional(),
  from: z.string().min(1).max(500).optional(),
  to: z.string().min(1).max(500).optional(),
  subject: z.string().min(1).max(500).optional(),
  after: utcDate.optional(),
  before: utcDate.optional(),
  tag: tagId.optional(),
  unread: z.boolean().optional(),
  flagged: z.boolean().optional(),
  has_attachment: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(512).optional(),
};
type SearchInput = z.infer<z.ZodObject<typeof searchInput>>;

function filterOf(input: SearchInput) {
  const conditions: Record<string, unknown>[] = [];
  if (input.mailbox_id) conditions.push({ inMailbox: input.mailbox_id });
  for (const key of [
    "text",
    "from",
    "to",
    "subject",
    "after",
    "before",
  ] as const)
    if (input[key] !== undefined) conditions.push({ [key]: input[key] });
  if (input.tag) conditions.push({ hasKeyword: `${tagPrefix}${input.tag}` });
  if (input.unread !== undefined)
    conditions.push({
      [input.unread ? "notKeyword" : "hasKeyword"]: systemFlags.seen,
    });
  if (input.flagged !== undefined)
    conditions.push({
      [input.flagged ? "hasKeyword" : "notKeyword"]: systemFlags.flagged,
    });
  if (input.has_attachment !== undefined)
    conditions.push({ hasAttachment: input.has_attachment });
  // Stalwart rejects `filter: null`; no conditions means no filter at all.
  return conditions.length ? { filter: { operator: "AND", conditions } } : {};
}

export const searchEmails = tool({
  name: "pim_search_emails",
  description:
    "Search emails, newest first. All given filters must match: mailbox_id, text (anywhere), from, to, subject, after/before (received, ISO 8601), tag (a Bulwark tag ID), unread, flagged, has_attachment. Returns summaries with flags, tags and other keywords; read one with pim_get_email. Pass next_cursor with the same filters and limit for the next page; positions shift if mail arrives meanwhile.",
  input: searchInput,
  async run(input, { jmap, signal }) {
    const position = decodeCursor("pim_search_emails", input);
    const [query, get] = await jmap.call(
      ["mail"],
      [
        [
          "Email/query",
          {
            ...filterOf(input),
            sort: [{ property: "receivedAt", isAscending: false }],
            position,
            limit: input.limit,
            calculateTotal: true,
          },
        ],
        [
          "Email/get",
          {
            "#ids": { resultOf: "c0", name: "Email/query", path: "/ids" },
            properties: summaryProperties,
          },
        ],
      ],
      signal,
    );
    const page = expect(queryPage, query);
    const { list } = expect(getList, get);
    const byId = new Map(
      list.map((entry) => [(entry as { id?: unknown }).id, entry]),
    );
    // Mail deleted between the query and the get is simply absent.
    const items = page.ids.flatMap((emailId) =>
      byId.has(emailId) ? [summarize(byId.get(emailId))] : [],
    );
    return {
      items,
      total: page.total ?? null,
      next_cursor: nextCursor(
        "pim_search_emails",
        input,
        page.position,
        page.ids.length,
        page.total,
      ),
    };
  },
});

const bodyPart = z.object({ partId: z.string().nullable(), type: z.string() });
const attachment = z.object({
  blobId: z.string().nullable(),
  name: z.string().nullable(),
  type: z.string(),
  size: z.number().int().nonnegative(),
});
const fullEmail = z.object({
  cc: addresses,
  bcc: addresses,
  replyTo: addresses,
  sentAt: z.string().nullable(),
  messageId: z.array(z.string()).nullable(),
  inReplyTo: z.array(z.string()).nullable(),
  references: z.array(z.string()).nullable(),
  textBody: z.array(bodyPart),
  bodyValues: z.record(
    z.string(),
    z.object({ value: z.string(), isTruncated: z.boolean() }),
  ),
  attachments: z.array(attachment),
});

export const getEmail = tool({
  name: "pim_get_email",
  description:
    "Read one email by ID: summary fields plus cc, bcc, reply-to, message headers, the readable body and attachment metadata (attachment contents are not returned). An HTML-only body is converted to plain text. The body is cut at max_body_bytes (default 20000) and marked truncated.",
  input: {
    email_id: id,
    max_body_bytes: z.number().int().min(1000).max(200_000).default(20_000),
  },
  async run(input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["mail"],
      [
        [
          "Email/get",
          {
            ids: [input.email_id],
            properties: [
              ...summaryProperties,
              "cc",
              "bcc",
              "replyTo",
              "sentAt",
              "messageId",
              "inReplyTo",
              "references",
              "textBody",
              "attachments",
              "bodyValues",
            ],
            fetchTextBodyValues: true,
            maxBodyValueBytes: input.max_body_bytes,
          },
        ],
      ],
      signal,
    );
    const { list } = expect(getList, result);
    const value = list.find(
      (entry) => (entry as { id?: unknown }).id === input.email_id,
    );
    if (!value) throw new SafeError("NOT_FOUND");
    const email = expect(fullEmail, value);
    const parts = email.textBody.filter(
      (part) => part.partId && email.bodyValues[part.partId],
    );
    const html = parts.some((part) => part.type === "text/html");
    const text = parts
      .map((part) => {
        const body = email.bodyValues[part.partId!]!.value;
        return part.type === "text/html" ? htmlToText(body) : body;
      })
      .join("\n\n");
    return {
      ...summarize(value),
      cc: people(email.cc),
      bcc: people(email.bcc),
      reply_to: people(email.replyTo),
      sent_at: email.sentAt,
      message_id: email.messageId?.[0] ?? null,
      in_reply_to: email.inReplyTo ?? [],
      references: email.references ?? [],
      body: {
        text,
        format: html ? "html_converted" : "text",
        truncated: parts.some(
          (part) => email.bodyValues[part.partId!]!.isTruncated,
        ),
      },
      attachments: email.attachments.map((entry) => ({
        blob_id: entry.blobId,
        name: entry.name,
        type: entry.type,
        size: entry.size,
      })),
    };
  },
});

const threadList = z.object({
  list: z.array(z.object({ id: z.string(), emailIds: z.array(z.string()) })),
});

export const getThread = tool({
  name: "pim_get_thread",
  description:
    "Read a conversation by thread ID: summaries of all its emails, oldest first.",
  input: { thread_id: id },
  async run(input, { jmap, signal }) {
    const [thread, get] = await jmap.call(
      ["mail"],
      [
        ["Thread/get", { ids: [input.thread_id] }],
        [
          "Email/get",
          {
            "#ids": {
              resultOf: "c0",
              name: "Thread/get",
              path: "/list/*/emailIds",
            },
            properties: summaryProperties,
          },
        ],
      ],
      signal,
    );
    const found = expect(threadList, thread).list.find(
      (entry) => entry.id === input.thread_id,
    );
    if (!found) throw new SafeError("NOT_FOUND");
    const byId = new Map(
      expect(getList, get).list.map((entry) => [
        (entry as { id?: unknown }).id,
        entry,
      ]),
    );
    return {
      thread_id: found.id,
      items: found.emailIds.flatMap((emailId) =>
        byId.has(emailId) ? [summarize(byId.get(emailId))] : [],
      ),
    };
  },
});

const identityList = z.object({
  list: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
});

export const listIdentities = tool({
  name: "pim_list_identities",
  description:
    "List the identities (From addresses) this account may send as. Drafts and sent mail use an identity ID.",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["mail", "submission"],
      [["Identity/get", { ids: null }]],
      signal,
    );
    return {
      items: expect(identityList, result).list.map((identity) => ({
        identity_id: identity.id,
        name: identity.name,
        email: identity.email,
      })),
    };
  },
});
