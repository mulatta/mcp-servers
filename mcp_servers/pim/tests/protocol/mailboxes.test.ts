import { afterEach, beforeEach, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";

let env: Connected;
beforeEach(async () => {
  env = await connected();
});
afterEach(() => env.stop());

test("lists mailboxes with roles, counts and parents", async () => {
  env.stalwart.jmap = (calls) =>
    calls.map(([name, , id]) => [
      name,
      {
        accountId: "a1",
        state: "1",
        notFound: [],
        list: [
          {
            id: "m1",
            name: "Inbox",
            parentId: null,
            role: "inbox",
            sortOrder: 0,
            totalEmails: 12,
            unreadEmails: 3,
          },
          {
            id: "m2",
            name: "Receipts",
            parentId: "m1",
            role: null,
            sortOrder: 5,
            totalEmails: 2,
            unreadEmails: 0,
          },
        ],
      },
      id,
    ]);
  const result = await env.call("pim_list_mailboxes");
  expect(result.isError).toBe(false);
  expect(result.structured).toEqual({
    items: [
      {
        mailbox_id: "m1",
        name: "Inbox",
        parent_id: null,
        role: "inbox",
        total_emails: 12,
        unread_emails: 3,
      },
      {
        mailbox_id: "m2",
        name: "Receipts",
        parent_id: "m1",
        role: null,
        total_emails: 2,
        unread_emails: 0,
      },
    ],
  });
  const [method, args] = env.stalwart.jmapRequests[0]!.calls[0]!;
  expect(method).toBe("Mailbox/get");
  expect(args.ids).toBeNull();
});

test("an unexpected shape is an error, not an empty list", async () => {
  env.stalwart.jmap = (calls) =>
    calls.map(([name, , id]) => [name, { list: [{ id: 5 }] }, id]);
  const result = await env.call("pim_list_mailboxes");
  expect(result.error?.code).toBe("UPSTREAM_CHANGED");
});

test("unknown arguments are rejected before any request", async () => {
  const result = await env.client.callTool({
    name: "pim_list_mailboxes",
    arguments: { extra: 1 },
  });
  expect(result.isError).toBe(true);
  expect(env.stalwart.jmapRequests).toHaveLength(0);
});

test("read tools are read-only and write tools are hidden by default", async () => {
  const { tools } = await env.client.listTools();
  const mailboxes = tools.find((tool) => tool.name === "pim_list_mailboxes")!;
  expect(mailboxes.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(
    true,
  );
});
