import { afterEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import { answer } from "../fixtures/answer.ts";
import type { MethodCall } from "../fixtures/stalwart.ts";

let env: Connected;
afterEach(() => env.stop());
const writes = (index: number) => env.stalwart.jmapRequests[index]!.calls;

const mailboxes = {
  "Mailbox/get": {
    list: [
      { id: "inbox", role: "inbox", name: "Inbox" },
      { id: "trash", role: "trash", name: "Trash" },
      { id: "junk", role: "junk", name: "Junk" },
      { id: "drafts", role: "drafts", name: "Drafts" },
      { id: "sent", role: "sent", name: "Sent" },
    ],
  },
};

describe("write groups", () => {
  test("each group exposes only its own tools, annotated as writes", async () => {
    env = await connected({ writes: ["flag"] });
    const { tools } = await env.client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("pim_set_email_flags");
    expect(names).not.toContain("pim_move_emails");
    expect(names).not.toContain("pim_destroy_emails");
    const flags = tools.find((tool) => tool.name === "pim_set_email_flags")!;
    expect(flags.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});

describe("flag", () => {
  test("patches only the requested keywords and reports confirmed IDs", async () => {
    env = await connected({ writes: ["flag"] });
    env.stalwart.jmap = answer({
      "Email/set": { updated: { e1: null, e2: null } },
    });
    const result = await env.call("pim_set_email_flags", {
      email_ids: ["e1", "e2"],
      seen: true,
      flagged: false,
      add_tags: ["work"],
      remove_tags: ["later"],
    });
    expect(result.structured).toEqual({ updated: ["e1", "e2"], failed: [] });
    const [method, args] = writes(0)[0]!;
    expect(method).toBe("Email/set");
    const patch = {
      "keywords/$seen": true,
      "keywords/$flagged": null,
      "keywords/$label:work": true,
      "keywords/$label:later": null,
    };
    expect(args.update).toEqual({ e1: patch, e2: patch });
  });

  test("partial failures are listed; total failure is an error", async () => {
    env = await connected({ writes: ["flag"] });
    env.stalwart.jmap = answer({
      "Email/set": {
        updated: { e1: null },
        notUpdated: { e2: { type: "notFound" } },
      },
    });
    expect(
      (
        await env.call("pim_set_email_flags", {
          email_ids: ["e1", "e2"],
          seen: true,
        })
      ).structured,
    ).toEqual({
      updated: ["e1"],
      failed: [{ id: "e2", code: "NOT_FOUND" }],
    });
    env.stalwart.jmap = answer({
      "Email/set": { notUpdated: { e2: { type: "notFound" } } },
    });
    expect(
      (await env.call("pim_set_email_flags", { email_ids: ["e2"], seen: true }))
        .error?.code,
    ).toBe("NOT_FOUND");
  });

  test("an answer that confirms nothing is an unknown outcome", async () => {
    env = await connected({ writes: ["flag"] });
    env.stalwart.jmap = answer({ "Email/set": {} });
    expect(
      (await env.call("pim_set_email_flags", { email_ids: ["e1"], seen: true }))
        .error?.code,
    ).toBe("WRITE_OUTCOME_UNKNOWN");
  });

  test("a request without a change or with repeated IDs is rejected before sending", async () => {
    env = await connected({ writes: ["flag"] });
    for (const args of [
      { email_ids: ["e1"] },
      { email_ids: ["e1", "e1"], seen: true },
      { email_ids: ["e1"], add_tags: ["a b"] },
    ]) {
      expect(
        (
          await env.client.callTool({
            name: "pim_set_email_flags",
            arguments: args,
          })
        ).isError,
      ).toBe(true);
    }
    expect(env.stalwart.jmapRequests).toHaveLength(0);
  });

  test("a timeout after sending is an unknown outcome", async () => {
    env = await connected({ writes: ["flag"], timeoutMs: 50 });
    env.stalwart.jmap = async (calls) => {
      await Bun.sleep(200);
      return answer({ "Email/set": { updated: { e1: null } } })(calls);
    };
    expect(
      (await env.call("pim_set_email_flags", { email_ids: ["e1"], seen: true }))
        .error?.code,
    ).toBe("WRITE_OUTCOME_UNKNOWN");
  });
});

describe("organize", () => {
  test("move replaces every mailbox; add and remove touch one", async () => {
    env = await connected({ writes: ["organize"] });
    env.stalwart.jmap = answer({ "Email/set": { updated: { e1: null } } });
    await env.call("pim_move_emails", { email_ids: ["e1"], mailbox_id: "m2" });
    await env.call("pim_add_emails_to_mailbox", {
      email_ids: ["e1"],
      mailbox_id: "m3",
    });
    await env.call("pim_remove_emails_from_mailbox", {
      email_ids: ["e1"],
      mailbox_id: "m3",
    });
    expect(writes(0)[0]![1].update).toEqual({
      e1: { mailboxIds: { m2: true } },
    });
    expect(writes(1)[0]![1].update).toEqual({ e1: { "mailboxIds/m3": true } });
    expect(writes(2)[0]![1].update).toEqual({ e1: { "mailboxIds/m3": null } });
  });

  test("mailboxes are created, renamed and deleted only when empty", async () => {
    env = await connected({ writes: ["organize"] });
    env.stalwart.jmap = answer({
      "Mailbox/set": { created: { new: { id: "m9" } } },
    });
    expect(
      (
        await env.call("pim_create_mailbox", {
          name: "Receipts",
          parent_id: "inbox",
        })
      ).structured,
    ).toEqual({
      mailbox_id: "m9",
      name: "Receipts",
      parent_id: "inbox",
    });
    expect(writes(0)[0]![1].create).toEqual({
      new: { name: "Receipts", parentId: "inbox" },
    });

    env.stalwart.jmap = answer({ "Mailbox/set": { updated: { m9: null } } });
    await env.call("pim_update_mailbox", {
      mailbox_id: "m9",
      name: "Bills",
      parent_id: null,
    });
    expect(writes(1)[0]![1].update).toEqual({
      m9: { name: "Bills", parentId: null },
    });

    env.stalwart.jmap = answer({
      "Mailbox/set": { notDestroyed: { m9: { type: "mailboxHasEmail" } } },
    });
    expect(
      (await env.call("pim_delete_mailbox", { mailbox_id: "m9" })).error?.code,
    ).toBe("MAILBOX_NOT_EMPTY");
    expect(writes(2)[0]![1]).toMatchObject({
      destroy: ["m9"],
      onDestroyRemoveEmails: false,
    });
  });

  test("a create whose answer was lost is an unknown outcome", async () => {
    env = await connected({ writes: ["organize"] });
    env.stalwart.jmap = () => new Response(null, { status: 502 });
    expect(
      (await env.call("pim_create_mailbox", { name: "X" })).error?.code,
    ).toBe("WRITE_OUTCOME_UNKNOWN");
  });
});

describe("delete", () => {
  test("trash moves emails into the trash mailbox", async () => {
    env = await connected({ writes: ["delete"] });
    env.stalwart.jmap = answer({
      ...mailboxes,
      "Email/set": { updated: { e1: null } },
    });
    expect(
      (await env.call("pim_trash_emails", { email_ids: ["e1"] })).structured,
    ).toEqual({
      trashed: ["e1"],
      failed: [],
    });
    expect(writes(1)[0]![1].update).toEqual({
      e1: { mailboxIds: { trash: true } },
    });
  });

  test("destroy refuses emails outside Trash and Junk without sending", async () => {
    env = await connected({ writes: ["delete"] });
    env.stalwart.jmap = answer({
      ...mailboxes,
      "Email/get": {
        list: [
          { id: "e1", mailboxIds: { trash: true } },
          { id: "e2", mailboxIds: { inbox: true, trash: true } },
        ],
        notFound: [],
      },
    });
    expect(
      (await env.call("pim_destroy_emails", { email_ids: ["e1", "e2"] })).error
        ?.code,
    ).toBe("NOT_IN_TRASH");
    expect(
      env.stalwart.jmapRequests.flatMap((request) =>
        request.calls.map(([name]) => name),
      ),
    ).not.toContain("Email/set");
  });

  test("destroy removes emails that are only in Trash or Junk", async () => {
    env = await connected({ writes: ["delete"] });
    env.stalwart.jmap = (calls) =>
      calls.map(([name, , id]): MethodCall => {
        if (name === "Email/get")
          return [
            name,
            {
              list: [
                { id: "e1", mailboxIds: { trash: true } },
                { id: "e2", mailboxIds: { junk: true } },
              ],
              notFound: [],
            },
            id,
          ];
        if (name === "Email/set")
          return [name, { destroyed: ["e1", "e2"] }, id];
        return [name, mailboxes["Mailbox/get"], id];
      });
    expect(
      (await env.call("pim_destroy_emails", { email_ids: ["e1", "e2"] }))
        .structured,
    ).toEqual({
      destroyed: ["e1", "e2"],
      failed: [],
    });
    const { tools } = await env.client.listTools();
    expect(
      tools.find((tool) => tool.name === "pim_destroy_emails")!.annotations
        ?.destructiveHint,
    ).toBe(true);
  });
});
