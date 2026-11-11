import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import type { MethodCall } from "../fixtures/stalwart.ts";

let env: Connected;
beforeEach(async () => {
  env = await connected();
});
afterEach(() => env.stop());

const email = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId: `t-${id}`,
  mailboxIds: { m1: true },
  keywords: { $seen: true, "$label:work": true, $forwarded: true },
  from: [{ name: "Sender", email: "sender@example.test" }],
  to: [{ name: null, email: "tester@example.test" }],
  subject: `Subject ${id}`,
  receivedAt: "2026-11-01T10:00:00Z",
  preview: "Preview text",
  hasAttachment: false,
  size: 1200,
  ...extra,
});
const summary = (id: string) => ({
  email_id: id,
  thread_id: `t-${id}`,
  mailbox_ids: ["m1"],
  from: [{ name: "Sender", email: "sender@example.test" }],
  to: [{ name: null, email: "tester@example.test" }],
  subject: `Subject ${id}`,
  received_at: "2026-11-01T10:00:00Z",
  preview: "Preview text",
  has_attachment: false,
  size: 1200,
  flags: { seen: true, flagged: false, answered: false, draft: false },
  tags: ["work"],
  keywords: ["$forwarded"],
});

/** Answers each method with the given arguments. */
const answer =
  (byMethod: Record<string, Record<string, unknown>>) =>
  (calls: MethodCall[]) =>
    calls.map(([name, , id]): MethodCall => [name, byMethod[name] ?? {}, id]);

describe("pim_search_emails", () => {
  test("builds one query and returns summaries newest first", async () => {
    env.stalwart.jmap = answer({
      "Email/query": {
        ids: ["e1", "e2"],
        position: 0,
        total: 2,
        queryState: "q",
      },
      "Email/get": { list: [email("e1"), email("e2")], notFound: [] },
    });
    const result = await env.call("pim_search_emails", {
      mailbox_id: "m1",
      text: "invoice",
      from: "billing@example.test",
      after: "2026-10-01T00:00:00Z",
      tag: "work",
      unread: true,
      limit: 2,
    });
    expect(result.structured).toEqual({
      items: [summary("e1"), summary("e2")],
      total: 2,
      next_cursor: null,
    });
    const [[query, queryArgs], [get, getArgs]] = env.stalwart.jmapRequests[0]!
      .calls as [MethodCall, MethodCall];
    expect(query).toBe("Email/query");
    expect(queryArgs).toMatchObject({
      filter: {
        operator: "AND",
        conditions: [
          { inMailbox: "m1" },
          { text: "invoice" },
          { from: "billing@example.test" },
          { after: "2026-10-01T00:00:00Z" },
          { hasKeyword: "$label:work" },
          { notKeyword: "$seen" },
        ],
      },
      sort: [{ property: "receivedAt", isAscending: false }],
      position: 0,
      limit: 2,
      calculateTotal: true,
    });
    expect(get).toBe("Email/get");
    expect(getArgs["#ids"]).toEqual({
      resultOf: "c0",
      name: "Email/query",
      path: "/ids",
    });
  });

  test("pages with a cursor tied to the same search", async () => {
    env.stalwart.jmap = answer({
      "Email/query": { ids: ["e1"], position: 0, total: 3, queryState: "q" },
      "Email/get": { list: [email("e1")], notFound: [] },
    });
    const first = await env.call("pim_search_emails", { text: "x", limit: 1 });
    const cursor = first.structured!.next_cursor as string;
    expect(cursor).toEqual(expect.any(String));
    env.stalwart.jmap = answer({
      "Email/query": { ids: ["e2"], position: 1, total: 3, queryState: "q" },
      "Email/get": { list: [email("e2")], notFound: [] },
    });
    await env.call("pim_search_emails", { text: "x", limit: 1, cursor });
    expect(env.stalwart.jmapRequests[1]!.calls[0]![1].position).toBe(1);
    const other = await env.call("pim_search_emails", {
      text: "y",
      limit: 1,
      cursor,
    });
    expect(other.error?.code).toBe("CURSOR_INVALID");
    const garbage = await env.call("pim_search_emails", { cursor: "nonsense" });
    expect(garbage.error?.code).toBe("CURSOR_INVALID");
  });

  test("a search without conditions sends no filter", async () => {
    env.stalwart.jmap = answer({
      "Email/query": { ids: [], position: 0, total: 0, queryState: "q" },
      "Email/get": { list: [], notFound: [] },
    });
    await env.call("pim_search_emails", {});
    expect("filter" in env.stalwart.jmapRequests[0]!.calls[0]![1]).toBe(false);
  });

  test("an email that vanished between query and get is skipped", async () => {
    env.stalwart.jmap = answer({
      "Email/query": {
        ids: ["e1", "gone"],
        position: 0,
        total: 2,
        queryState: "q",
      },
      "Email/get": { list: [email("e1")], notFound: ["gone"] },
    });
    const result = await env.call("pim_search_emails", {});
    expect(result.structured!.items).toHaveLength(1);
  });

  test("rejects malformed dates and tag IDs before any request", async () => {
    for (const args of [
      { after: "yesterday" },
      { tag: "has space" },
      { limit: 0 },
    ]) {
      const result = await env.client.callTool({
        name: "pim_search_emails",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    expect(env.stalwart.jmapRequests).toHaveLength(0);
  });
});

describe("pim_get_email", () => {
  test("returns headers, plain text body and attachment metadata", async () => {
    env.stalwart.jmap = answer({
      "Email/get": {
        notFound: [],
        list: [
          email("e1", {
            cc: null,
            bcc: null,
            replyTo: [{ name: "Help", email: "help@example.test" }],
            sentAt: "2026-11-01T09:59:00+09:00",
            messageId: ["m1@example.test"],
            inReplyTo: null,
            references: null,
            textBody: [{ partId: "1", type: "text/plain" }],
            bodyValues: {
              "1": {
                value: "Hello\nWorld",
                isTruncated: false,
                isEncodingProblem: false,
              },
            },
            attachments: [
              {
                partId: "2",
                blobId: "b2",
                name: "a.pdf",
                type: "application/pdf",
                size: 900,
                disposition: "attachment",
              },
            ],
          }),
        ],
      },
    });
    const result = await env.call("pim_get_email", { email_id: "e1" });
    expect(result.structured).toEqual({
      ...summary("e1"),
      cc: [],
      bcc: [],
      reply_to: [{ name: "Help", email: "help@example.test" }],
      sent_at: "2026-11-01T09:59:00+09:00",
      message_id: "m1@example.test",
      in_reply_to: [],
      references: [],
      body: { text: "Hello\nWorld", format: "text", truncated: false },
      attachments: [
        { blob_id: "b2", name: "a.pdf", type: "application/pdf", size: 900 },
      ],
    });
    const args = env.stalwart.jmapRequests[0]!.calls[0]![1];
    expect(args).toMatchObject({
      ids: ["e1"],
      fetchTextBodyValues: true,
      maxBodyValueBytes: 20000,
    });
  });

  test("an HTML-only body is converted to text", async () => {
    env.stalwart.jmap = answer({
      "Email/get": {
        notFound: [],
        list: [
          email("e1", {
            cc: null,
            bcc: null,
            replyTo: null,
            sentAt: null,
            messageId: null,
            inReplyTo: null,
            references: null,
            textBody: [{ partId: "1", type: "text/html" }],
            bodyValues: {
              "1": {
                value:
                  "<html><style>p{}</style><p>Hi&nbsp;there &amp; you</p><p>Line<br>two</p><script>x()</script></html>",
                isTruncated: true,
                isEncodingProblem: false,
              },
            },
            attachments: [],
          }),
        ],
      },
    });
    const result = await env.call("pim_get_email", {
      email_id: "e1",
      max_body_bytes: 5000,
    });
    expect(result.structured!.body).toEqual({
      text: "Hi there & you\nLine\ntwo",
      format: "html_converted",
      truncated: true,
    });
  });

  test("an unknown email is NOT_FOUND", async () => {
    env.stalwart.jmap = answer({ "Email/get": { list: [], notFound: ["zz"] } });
    expect(
      (await env.call("pim_get_email", { email_id: "zz" })).error?.code,
    ).toBe("NOT_FOUND");
  });
});

describe("pim_get_thread", () => {
  test("returns the thread's emails oldest first", async () => {
    env.stalwart.jmap = answer({
      "Thread/get": {
        list: [{ id: "t1", emailIds: ["e1", "e2"] }],
        notFound: [],
      },
      "Email/get": { list: [email("e1"), email("e2")], notFound: [] },
    });
    const result = await env.call("pim_get_thread", { thread_id: "t1" });
    expect(result.structured).toEqual({
      thread_id: "t1",
      items: [summary("e1"), summary("e2")],
    });
    const calls = env.stalwart.jmapRequests[0]!.calls;
    expect(calls[1]![1]["#ids"]).toEqual({
      resultOf: "c0",
      name: "Thread/get",
      path: "/list/*/emailIds",
    });
  });

  test("an unknown thread is NOT_FOUND", async () => {
    env.stalwart.jmap = answer({
      "Thread/get": { list: [], notFound: ["t9"] },
      "Email/get": { list: [], notFound: [] },
    });
    expect(
      (await env.call("pim_get_thread", { thread_id: "t9" })).error?.code,
    ).toBe("NOT_FOUND");
  });
});

test("pim_list_identities lists sending identities", async () => {
  env.stalwart.jmap = answer({
    "Identity/get": {
      list: [
        {
          id: "i1",
          name: "Tester",
          email: "tester@example.test",
          replyTo: null,
          bcc: null,
          mayDelete: false,
        },
      ],
      notFound: [],
    },
  });
  const result = await env.call("pim_list_identities");
  expect(result.structured).toEqual({
    items: [
      { identity_id: "i1", name: "Tester", email: "tester@example.test" },
    ],
  });
  expect(env.stalwart.jmapRequests[0]!.using).toContain(
    "urn:ietf:params:jmap:submission",
  );
});
