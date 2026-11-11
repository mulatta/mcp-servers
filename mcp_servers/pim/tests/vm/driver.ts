// Drives a running pim-mcp over HTTP against a real Stalwart in the NixOS
// VM test: every tool, read and write, on a throwaway account. It prints
// step names and codes only.
import { readFileSync } from "node:fs";

const url = new URL(process.env.PIM_VM_URL ?? "http://127.0.0.1:8766/mcp");
const token = readFileSync(process.env.PIM_VM_TOKEN_FILE!, "utf8").trim();
const self = process.env.PIM_VM_ADDRESS!;
const friend = process.env.PIM_VM_FRIEND!;

type Result = Record<string, any>;
class ToolError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

let serial = 0;
/** One stateless JSON-RPC exchange with the server's /mcp endpoint. */
async function rpc(
  method: string,
  params: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++serial, method, params }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`);
  const body = (await response.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const result = await rpc("tools/call", { name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "{}";
  if (result.isError) throw new ToolError(JSON.parse(text).code ?? text);
  return result.structuredContent as Result;
}
async function refused(
  code: string,
  name: string,
  args: Record<string, unknown>,
) {
  try {
    await call(name, args);
  } catch (error) {
    if (error instanceof ToolError && error.code === code) return;
    throw error;
  }
  throw new Error(`${name} should fail with ${code}`);
}
function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${what}`);
}
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function step(name: string, run: () => Promise<void>) {
  await run();
  console.log(`ok ${name}`);
}

const marker = `pim-vm-${crypto.randomUUID().slice(0, 8)}`;
const word = marker.replaceAll("-", "");
const roles: Record<string, string> = {};

await step("tools listed", async () => {
  const { tools } = await rpc("tools/list", {});
  check(tools.length === 39, "every group enabled");
});

await step("mailboxes and identities", async () => {
  for (const box of (await call("pim_list_mailboxes")).items)
    if (box.role) roles[box.role] = box.mailbox_id;
  for (const role of ["inbox", "drafts", "sent", "trash", "junk"])
    check(roles[role], `${role} mailbox`);
  const { items } = await call("pim_list_identities");
  check(
    items.some((identity: Result) => identity.email === self),
    `identity for the account: ${JSON.stringify(items.map((i: Result) => i.email))}`,
  );
});

let draftId = "";
await step("draft create, update, delete", async () => {
  const draft = {
    to: [{ email: friend }],
    subject: `${marker} draft`,
    text_body: "first",
  };
  const { email_id } = await call("pim_create_draft", draft);
  const found = await call("pim_search_emails", {
    mailbox_id: roles.drafts,
    subject: marker,
  });
  check(
    found.items.some(
      (email: Result) => email.email_id === email_id && email.flags.draft,
    ),
    "draft in Drafts",
  );
  const updated = await call("pim_update_draft", {
    email_id,
    ...draft,
    text_body: "second",
  });
  draftId = updated.email_id;
  check(
    (await call("pim_get_email", { email_id: draftId })).body.text.includes(
      "second",
    ),
    "updated body",
  );
  await refused("NOT_FOUND", "pim_get_email", { email_id });
  const scratch = await call("pim_create_draft", {
    ...draft,
    subject: `${marker} scratch`,
  });
  await call("pim_delete_draft", { email_id: scratch.email_id });
  await refused("NOT_FOUND", "pim_get_email", { email_id: scratch.email_id });
});

/** The copy in Sent once the server has filed it there. */
const filedInSent = (subject: string) =>
  until(`${subject} filed in Sent`, async () => {
    const { items } = await call("pim_search_emails", {
      mailbox_id: roles.sent,
      subject,
    });
    return items[0];
  });

// Stalwart drops a delivered copy whose Message-ID the account already
// holds, so mail goes to a second account; the VM test checks its inbox.
let mailId = "";
await step("send", async () => {
  const sent = await call("pim_send_email", {
    to: [{ email: friend, name: "Friend" }],
    subject: `${marker} hello`,
    text_body: "Hello from the VM.\nSecond line.",
  });
  check(sent.submission_id, "submission");
  const copy = await filedInSent(`${marker} hello`);
  check(
    copy.email_id === sent.email_id && !copy.flags.draft,
    "sent copy is no longer a draft",
  );
  mailId = copy.email_id;
  const email = await call("pim_get_email", { email_id: mailId });
  check(email.body.text.includes("Second line."), "body");
  check(
    email.from[0].email === self && email.to[0].email === friend,
    "addresses",
  );
  await refused("NOT_A_DRAFT", "pim_delete_draft", { email_id: mailId });
  const thread = await call("pim_get_thread", { thread_id: email.thread_id });
  check(
    thread.items.some((item: Result) => item.email_id === mailId),
    "thread",
  );
});

await step("reply and send a draft", async () => {
  const reply = await call("pim_create_draft", {
    to: [{ email: friend }],
    text_body: "A follow-up.",
    reply_to_email_id: mailId,
  });
  const original = await call("pim_get_email", { email_id: mailId });
  const draft = await call("pim_get_email", { email_id: reply.email_id });
  check(draft.subject === `Re: ${marker} hello`, "reply subject");
  check(draft.in_reply_to[0] === original.message_id, "threaded");
  await call("pim_delete_draft", { email_id: reply.email_id });
  const sent = await call("pim_send_draft", { email_id: draftId });
  check(sent.email_id === draftId, "same email");
  const copy = await filedInSent(`${marker} draft`);
  check(copy.email_id === draftId && !copy.flags.draft, "draft filed in Sent");
});

await step("flags and tags", async () => {
  await call("pim_set_email_flags", {
    email_ids: [mailId],
    seen: false,
    flagged: true,
    add_tags: ["work"],
  });
  const tagged = await call("pim_search_emails", {
    tag: "work",
    unread: true,
    flagged: true,
  });
  check(
    tagged.items.some((email: Result) => email.email_id === mailId),
    "found by tag and flags",
  );
  const email = await call("pim_get_email", { email_id: mailId });
  check(
    email.tags.includes("work") && email.flags.flagged && !email.flags.seen,
    "flags read back",
  );
  await call("pim_set_email_flags", {
    email_ids: [mailId],
    seen: true,
    remove_tags: ["work"],
  });
  check(
    (await call("pim_get_email", { email_id: mailId })).tags.length === 0,
    "tag removed",
  );
});

await step("mailboxes and filing", async () => {
  const { mailbox_id } = await call("pim_create_mailbox", {
    name: `${marker} folder`,
    parent_id: roles.inbox,
  });
  await call("pim_add_emails_to_mailbox", {
    email_ids: [mailId],
    mailbox_id,
  });
  let email = await call("pim_get_email", { email_id: mailId });
  check(
    email.mailbox_ids.includes(mailbox_id) &&
      email.mailbox_ids.includes(roles.sent),
    "in both",
  );
  await call("pim_remove_emails_from_mailbox", {
    email_ids: [mailId],
    mailbox_id,
  });
  await call("pim_move_emails", { email_ids: [mailId], mailbox_id });
  email = await call("pim_get_email", { email_id: mailId });
  check(
    email.mailbox_ids.length === 1 && email.mailbox_ids[0] === mailbox_id,
    "moved",
  );
  await call("pim_update_mailbox", {
    mailbox_id,
    name: `${marker} renamed`,
    parent_id: null,
  });
  const renamed = (await call("pim_list_mailboxes")).items.find(
    (box: Result) => box.mailbox_id === mailbox_id,
  );
  check(
    renamed.name === `${marker} renamed` && renamed.parent_id === null,
    "renamed",
  );
  await refused("MAILBOX_NOT_EMPTY", "pim_delete_mailbox", { mailbox_id });
  await call("pim_move_emails", {
    email_ids: [mailId],
    mailbox_id: roles.sent,
  });
  await call("pim_delete_mailbox", { mailbox_id });
});

await step("trash and destroy", async () => {
  await refused("NOT_IN_TRASH", "pim_destroy_emails", {
    email_ids: [mailId],
  });
  await call("pim_trash_emails", { email_ids: [mailId] });
  await call("pim_destroy_emails", { email_ids: [mailId] });
  await refused("NOT_FOUND", "pim_get_email", { email_id: mailId });
});

await step("sieve", async () => {
  const script = `require ["fileinto"];\nif header :contains "subject" "${marker}-filter" { fileinto "Junk"; }\n`;
  const verdict = await call("pim_validate_sieve_script", { content: script });
  check(verdict.valid, `valid script: ${verdict.error}`);
  const invalid = await call("pim_validate_sieve_script", {
    content: "this is not sieve",
  });
  check(!invalid.valid && invalid.error, "invalid script explained");
  await refused("INVALID_REQUEST", "pim_save_sieve_script", {
    name: "broken",
    content: "this is not sieve",
  });
  const { script_id } = await call("pim_save_sieve_script", {
    name: marker,
    content: script,
    activate: true,
  });
  const listed = (await call("pim_list_sieve_scripts")).items.find(
    (entry: Result) => entry.script_id === script_id,
  );
  check(listed?.active, "active after save");
  check(
    (await call("pim_get_sieve_script", { script_id })).content === script,
    "content read back",
  );
  await refused("WRITE_REJECTED", "pim_delete_sieve_script", { script_id });
  check(
    (await call("pim_activate_sieve_script", { script_id: null }))
      .active_script_id === null,
    "deactivated",
  );
  await call("pim_activate_sieve_script", { script_id });
  await call("pim_activate_sieve_script", { script_id: null });
  await call("pim_delete_sieve_script", { script_id });
});

await step("vacation", async () => {
  const set = await call("pim_set_vacation", {
    enabled: true,
    to_date: "2030-01-01T00:00:00Z",
    subject: "Away",
    text_body: "Back later",
  });
  check(
    set.enabled &&
      set.subject === "Away" &&
      set.to_date?.startsWith("2030-01-01"),
    "set",
  );
  check((await call("pim_get_vacation")).enabled, "read back");
  check(
    !(await call("pim_set_vacation", { enabled: false })).enabled,
    "disabled",
  );
});

await step("calendar", async () => {
  const calendars = (await call("pim_list_calendars")).items;
  check(calendars.length, "a calendar");
  const calendar_id = calendars[0].calendar_id;
  const { event_id } = await call("pim_create_event", {
    calendar_id,
    title: `${marker} meeting`,
    start: "2030-03-04T09:30:00",
    time_zone: "Asia/Seoul",
    duration: "PT1H",
    location: "Room 1",
  });
  const range = {
    after: "2030-03-01T00:00:00Z",
    before: "2030-03-08T00:00:00Z",
  };
  const byRange = await call("pim_search_events", range);
  const listed = byRange.items.find(
    (event: Result) => event.title === `${marker} meeting`,
  );
  check(
    listed && listed.utc_start?.startsWith("2030-03-04T00:30:00"),
    `found by range with UTC start: ${JSON.stringify(byRange.items.map((e: Result) => [e.start, e.utc_start]))}`,
  );
  // Text search reads Stalwart's search index, which is written after the event.
  await until("event in the search index", async () => {
    const { items } = await call("pim_search_events", {
      ...range,
      text: marker,
    });
    return items.length ? true : undefined;
  });
  const event = await call("pim_get_event", { event_id });
  check(
    event.locations[0] === "Room 1" && event.participants.length === 0,
    "details",
  );
  await call("pim_update_event", {
    event_id,
    title: `${marker} moved`,
    location: null,
  });
  check(
    (await call("pim_get_event", { event_id })).title === `${marker} moved`,
    "updated",
  );
  const day = await call("pim_create_event", {
    calendar_id,
    title: `${marker} trip`,
    start: "2030-03-05T00:00:00",
    duration: "P2D",
    all_day: true,
  });
  check(
    (await call("pim_get_event", { event_id: day.event_id })).all_day,
    "all day",
  );
  await call("pim_delete_event", { event_id: day.event_id });
  await call("pim_delete_event", { event_id });
  await refused("NOT_FOUND", "pim_get_event", { event_id });
});

await step("contacts", async () => {
  const books = (await call("pim_list_address_books")).items;
  check(books.length, "an address book");
  const { contact_id } = await call("pim_create_contact", {
    address_book_id: books[0].address_book_id,
    given_name: word,
    surname: "Ada",
    emails: ["ada@example.test"],
    phones: ["+1 555 0100"],
    organization: "Example Org",
    note: "From the VM",
  });
  // Contact search matches whole name words; a hyphen would split the marker.
  await until("contact in the search index", async () => {
    const { items } = await call("pim_search_contacts", { text: word });
    return items.some((card: Result) => card.contact_id === contact_id)
      ? true
      : undefined;
  });
  const card = await call("pim_get_contact", { contact_id });
  check(
    card.emails[0] === "ada@example.test" && card.notes[0] === "From the VM",
    "details",
  );
  await call("pim_update_contact", {
    contact_id,
    emails: ["ada2@example.test"],
    organization: null,
  });
  const updated = await call("pim_get_contact", { contact_id });
  check(
    updated.emails.join() === "ada2@example.test" &&
      updated.organizations.length === 0,
    "updated",
  );
  await call("pim_delete_contact", { contact_id });
  await refused("NOT_FOUND", "pim_get_contact", { contact_id });
});

console.log("all steps passed");
