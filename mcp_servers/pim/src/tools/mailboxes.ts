import { z } from "zod";
import { expect } from "./schema.ts";
import { tool } from "./define.ts";

const mailbox = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable(),
  role: z.string().nullable(),
  totalEmails: z.number().int().nonnegative(),
  unreadEmails: z.number().int().nonnegative(),
  sortOrder: z.number().int().optional(),
});
const mailboxes = z.object({ list: z.array(mailbox) });

export const listMailboxes = tool({
  name: "pim_list_mailboxes",
  description:
    "List the account's mailboxes (folders) with their IDs, parent, role (inbox, drafts, sent, trash, junk, archive or null) and email counts. Use the IDs with the other mail tools.",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["mail"],
      [
        [
          "Mailbox/get",
          {
            ids: null,
            properties: [
              "name",
              "parentId",
              "role",
              "sortOrder",
              "totalEmails",
              "unreadEmails",
            ],
          },
        ],
      ],
      signal,
    );
    const { list } = expect(mailboxes, result);
    return {
      items: list
        .toSorted(
          (a, b) =>
            (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
            a.name.localeCompare(b.name),
        )
        .map((box) => ({
          mailbox_id: box.id,
          name: box.name,
          parent_id: box.parentId,
          role: box.role,
          total_emails: box.totalEmails,
          unread_emails: box.unreadEmails,
        })),
    };
  },
});
