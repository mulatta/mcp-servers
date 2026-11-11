import { afterEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import type { MethodCall } from "../fixtures/stalwart.ts";

let env: Connected;
afterEach(() => env.stop());
const calls = () =>
  env.stalwart.jmapRequests.flatMap((request) => request.calls);
const sentMethods = () => calls().map(([name]) => name);

const boxes = [
  { id: "inbox", role: "inbox" },
  { id: "drafts", role: "drafts" },
  { id: "sent", role: "sent" },
];
const identities = [{ id: "i1", name: "Tester", email: "tester@example.test" }];
const original = {
  id: "o1",
  subject: "Lunch?",
  messageId: ["orig@example.test"],
  references: ["root@example.test"],
};
const draft = {
  id: "d1",
  mailboxIds: { drafts: true },
  keywords: { $draft: true, $seen: true },
  from: [{ name: "Tester", email: "tester@example.test" }],
};

/** A JMAP handler with fixed reads and per-method answers for writes. */
function server(
  writes: Record<
    string,
    (args: Record<string, unknown>) => Record<string, unknown>[]
  >,
) {
  return (requestCalls: MethodCall[]) =>
    requestCalls.flatMap(([name, args, id]): MethodCall[] => {
      if (name === "Mailbox/get") return [[name, { list: boxes }, id]];
      if (name === "Identity/get")
        return [[name, { list: identities, notFound: [] }, id]];
      if (name === "Email/get") {
        const ids = args.ids as string[];
        const known = [original, draft].filter((email) =>
          ids.includes(email.id),
        );
        return [
          [
            name,
            {
              list: known,
              notFound: ids.filter((x) => !known.some((e) => e.id === x)),
            },
            id,
          ],
        ];
      }
      const answers = writes[name];
      if (!answers) return [["error", { type: "unknownMethod" }, id]];
      return answers(args).map((answer, index): MethodCall => [
        index === 0 ? name : "Email/set",
        answer,
        id,
      ]);
    });
}

describe("draft", () => {
  test("creates a draft in Drafts from the identity, as a reply", async () => {
    env = await connected({ writes: ["draft"] });
    env.stalwart.jmap = server({
      "Email/set": () => [{ created: { draft: { id: "d9", threadId: "t9" } } }],
    });
    const result = await env.call("pim_create_draft", {
      to: [{ email: "friend@example.test", name: "Friend" }],
      text_body: "Sure, noon works.",
      reply_to_email_id: "o1",
    });
    expect(result.structured).toEqual({ email_id: "d9" });
    const create = calls().find(([name]) => name === "Email/set")![1]
      .create as Record<string, Record<string, unknown>>;
    expect(create.draft).toEqual({
      mailboxIds: { drafts: true },
      keywords: { $draft: true, $seen: true },
      from: [{ name: "Tester", email: "tester@example.test" }],
      to: [{ name: "Friend", email: "friend@example.test" }],
      cc: [],
      bcc: [],
      subject: "Re: Lunch?",
      inReplyTo: ["orig@example.test"],
      references: ["root@example.test", "orig@example.test"],
      textBody: [{ partId: "body", type: "text/plain" }],
      bodyValues: { body: { value: "Sure, noon works." } },
    });
    expect(sentMethods()).not.toContain("EmailSubmission/set");
  });

  test("a new draft needs a subject and an unknown identity is refused", async () => {
    env = await connected({ writes: ["draft"] });
    env.stalwart.jmap = server({});
    expect(
      (
        await env.client.callTool({
          name: "pim_create_draft",
          arguments: { to: [{ email: "a@example.test" }], text_body: "x" },
        })
      ).isError,
    ).toBe(true);
    const unknown = await env.call("pim_create_draft", {
      to: [{ email: "a@example.test" }],
      subject: "Hi",
      text_body: "x",
      identity_id: "nope",
    });
    expect(unknown.error?.code).toBe("NOT_FOUND");
    expect(sentMethods()).not.toContain("Email/set");
  });

  test("updating replaces the draft in one request", async () => {
    env = await connected({ writes: ["draft"] });
    env.stalwart.jmap = server({
      "Email/set": () => [
        { created: { draft: { id: "d2" } }, destroyed: ["d1"] },
      ],
    });
    const result = await env.call("pim_update_draft", {
      email_id: "d1",
      to: [{ email: "a@example.test" }],
      subject: "Hi",
      text_body: "v2",
    });
    expect(result.structured).toEqual({ email_id: "d2", replaced: "d1" });
    const set = calls().find(([name]) => name === "Email/set")![1];
    expect(set.destroy).toEqual(["d1"]);
  });

  test("only drafts in Drafts may be changed or deleted", async () => {
    env = await connected({ writes: ["draft"] });
    env.stalwart.jmap = server({ "Email/set": () => [{ destroyed: ["d1"] }] });
    expect(
      (await env.call("pim_delete_draft", { email_id: "o1" })).error?.code,
    ).toBe("NOT_A_DRAFT");
    expect(
      (
        await env.call("pim_update_draft", {
          email_id: "o1",
          to: [{ email: "a@example.test" }],
          subject: "x",
          text_body: "y",
        })
      ).error?.code,
    ).toBe("NOT_A_DRAFT");
    expect(sentMethods()).not.toContain("Email/set");
    expect(
      (await env.call("pim_delete_draft", { email_id: "d1" })).structured,
    ).toEqual({ deleted: "d1" });
  });

  test("the draft group alone never offers sending", async () => {
    env = await connected({ writes: ["draft"] });
    const names = (await env.client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pim_create_draft",
        "pim_update_draft",
        "pim_delete_draft",
      ]),
    );
    expect(names.filter((name) => name.includes("send"))).toEqual([]);
  });
});

describe("send", () => {
  test("sends a draft and moves it to Sent", async () => {
    env = await connected({ writes: ["send"] });
    env.stalwart.jmap = server({
      "EmailSubmission/set": () => [
        { created: { send: { id: "s1" } } },
        { updated: { d1: null } },
      ],
    });
    expect(
      (await env.call("pim_send_draft", { email_id: "d1" })).structured,
    ).toEqual({
      email_id: "d1",
      submission_id: "s1",
    });
    const submit = calls().find(([name]) => name === "EmailSubmission/set")![1];
    expect(submit.create).toEqual({
      send: { identityId: "i1", emailId: "d1" },
    });
    expect(submit.onSuccessUpdateEmail).toEqual({
      "#send": {
        "mailboxIds/drafts": null,
        "mailboxIds/sent": true,
        "keywords/$draft": null,
      },
    });
  });

  test("composes and sends in one request", async () => {
    env = await connected({ writes: ["send"] });
    env.stalwart.jmap = server({
      "Email/set": () => [{ created: { draft: { id: "d7" } } }],
      "EmailSubmission/set": () => [
        { created: { send: { id: "s7" } } },
        { updated: { d7: null } },
      ],
    });
    const result = await env.call("pim_send_email", {
      to: [{ email: "friend@example.test" }],
      subject: "Hello",
      text_body: "Hi!",
    });
    expect(result.structured).toEqual({ email_id: "d7", submission_id: "s7" });
    const request = env.stalwart.jmapRequests.at(-1)!.calls;
    expect(request.map(([name]) => name)).toEqual([
      "Email/set",
      "EmailSubmission/set",
    ]);
    expect(request[1]![1].create).toEqual({
      send: { identityId: "i1", emailId: "#draft" },
    });
  });

  test("a refused submission is an error and a lost answer is unknown", async () => {
    env = await connected({ writes: ["send"] });
    env.stalwart.jmap = server({
      "EmailSubmission/set": () => [
        { notCreated: { send: { type: "forbiddenToSend" } } },
      ],
    });
    expect(
      (await env.call("pim_send_draft", { email_id: "d1" })).error?.code,
    ).toBe("WRITE_REJECTED");
    env.stalwart.jmap = server({ "EmailSubmission/set": () => [{}] });
    expect(
      (await env.call("pim_send_draft", { email_id: "d1" })).error?.code,
    ).toBe("WRITE_OUTCOME_UNKNOWN");
  });

  test("only drafts are sent", async () => {
    env = await connected({ writes: ["send"] });
    env.stalwart.jmap = server({});
    expect(
      (await env.call("pim_send_draft", { email_id: "o1" })).error?.code,
    ).toBe("NOT_A_DRAFT");
    expect(sentMethods()).not.toContain("EmailSubmission/set");
  });
});
