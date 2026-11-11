import { afterEach, beforeEach, expect, test } from "bun:test";
import { SafeError } from "../../src/errors.ts";
import { using, type Attempt } from "../../src/jmap/client.ts";
import { accountId, session } from "../fixtures/stalwart.ts";
import { signedIn, type SignedIn } from "../fixtures/setup.ts";
import { captureLogs } from "../fixtures/log.ts";

let env: SignedIn;
beforeEach(async () => {
  env = await signedIn();
});
afterEach(() => env.stop());

const signal = () => new AbortController().signal;
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "none",
    (error) => (error instanceof SafeError ? error.code : String(error)),
  );
const fresh = (): Attempt => ({ dispatched: false });

test("calls carry the account, capabilities and bearer token; the session is fetched once", async () => {
  env.stalwart.jmap = (calls) =>
    calls.map(([name, , id]) => [name, { list: [], seen: name }, id]);
  const first = await env.jmap.call(
    ["mail"],
    [["Mailbox/get", { ids: null }]],
    signal(),
  );
  expect(first).toEqual([{ list: [], seen: "Mailbox/get" }]);
  await env.jmap.call(["mail"], [["Email/get", { ids: [] }]], signal());
  expect(env.stalwart.sessionRequests).toBe(1);
  const request = env.stalwart.jmapRequests[0]!;
  expect(request.using).toEqual([using.core, using.mail]);
  expect(request.calls[0]![1]).toEqual({ ids: null, accountId });
  expect(env.stalwart.accessTokens.has(request.token)).toBe(true);
});

test("results are matched to calls by ID, not position", async () => {
  env.stalwart.jmap = (calls) =>
    calls
      .map(
        ([name, , id]) =>
          [name, { id }, id] as [string, Record<string, unknown>, string],
      )
      .reverse();
  const results = await env.jmap.call(
    ["mail"],
    [
      ["Mailbox/get", {}],
      ["Email/get", {}],
    ],
    signal(),
  );
  expect(results).toEqual([{ id: "c0" }, { id: "c1" }]);
});

test("an API URL on another origin is refused before the token is sent there", async () => {
  const original = env.stalwart.origin;
  env.stalwart.jmap = () => [];
  const spoofed = {
    ...session(original),
    apiUrl: "https://elsewhere.example.test/jmap/",
  };
  const jmap = new (await import("../../src/jmap/client.ts")).Jmap(
    env.config,
    env.credentials,
    {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/jmap/session")
          ? Response.json(spoofed)
          : fetch(input, init)) as typeof fetch,
    },
  );
  expect(
    await codeOf(jmap.call(["mail"], [["Mailbox/get", {}]], signal())),
  ).toBe("UPSTREAM_CHANGED");
});

test("a refused access token is refreshed and the request sent once more", async () => {
  env.stalwart.jmap = (calls) => calls.map(([name, , id]) => [name, {}, id]);
  await env.jmap.call(["mail"], [["Mailbox/get", {}]], signal());
  env.stalwart.accessTokens.clear();
  await env.jmap.call(["mail"], [["Mailbox/get", {}]], signal());
  const refreshes = env.stalwart.tokenRequests.filter(
    (form) => form.get("grant_type") === "refresh_token",
  );
  expect(refreshes).toHaveLength(2);
  expect(env.stalwart.jmapRequests).toHaveLength(2);
});

test("a token refused twice means the login is gone", async () => {
  env.stalwart.jmap = () => new Response(null, { status: 401 });
  expect(
    await codeOf(env.jmap.call(["mail"], [["Mailbox/get", {}]], signal())),
  ).toBe("AUTH_REQUIRED");
});

test("method errors map to fixed codes", async () => {
  const cases: [string, string][] = [
    ["invalidArguments", "INVALID_REQUEST"],
    ["unknownMethod", "UPSTREAM_CHANGED"],
    ["forbidden", "WRITE_REJECTED"],
    ["anchorNotFound", "CURSOR_INVALID"],
    ["serverUnavailable", "UPSTREAM_UNAVAILABLE"],
  ];
  for (const [type, code] of cases) {
    env.stalwart.jmap = (calls) =>
      calls.map(([, , id]) => ["error", { type }, id]);
    expect(
      await codeOf(env.jmap.call(["mail"], [["Email/get", {}]], signal())),
    ).toBe(code);
  }
});

test("reads and writes fail differently once a request may have run", async () => {
  env.stalwart.jmap = () => new Response(null, { status: 503 });
  expect(
    await codeOf(env.jmap.call(["mail"], [["Email/get", {}]], signal())),
  ).toBe("UPSTREAM_UNAVAILABLE");
  const attempt = fresh();
  expect(
    await codeOf(
      env.jmap.call(["mail"], [["Email/set", {}]], signal(), { attempt }),
    ),
  ).toBe("WRITE_OUTCOME_UNKNOWN");
  expect(attempt.dispatched).toBe(true);
  env.stalwart.jmap = () => new Response("not json", { status: 200 });
  expect(
    await codeOf(
      env.jmap.call(["mail"], [["Email/set", {}]], signal(), {
        attempt: fresh(),
      }),
    ),
  ).toBe("WRITE_OUTCOME_UNKNOWN");
  env.stalwart.jmap = () => new Response(null, { status: 429 });
  expect(
    await codeOf(
      env.jmap.call(["mail"], [["Email/set", {}]], signal(), {
        attempt: fresh(),
      }),
    ),
  ).toBe("RATE_LIMITED");
  env.stalwart.jmap = (calls) =>
    calls.map(([, , id]) => ["error", { type: "serverFail" }, id]);
  expect(
    await codeOf(
      env.jmap.call(["mail"], [["Email/set", {}]], signal(), {
        attempt: fresh(),
      }),
    ),
  ).toBe("WRITE_OUTCOME_UNKNOWN");
});

test("a write records its methods and whether it was answered, nothing else", async () => {
  const { logger, records, flush } = captureLogs();
  env.stop();
  env = await signedIn({ logger });
  env.stalwart.jmap = (calls) =>
    calls.map(([name, , id]) => [
      name,
      { created: { x: { id: "secret-id" } } },
      id,
    ]);
  await env.jmap.call(
    ["mail"],
    [["Email/set", { create: { x: { subject: "private" } } }]],
    signal(),
    {
      attempt: fresh(),
    },
  );
  await flush();
  const write = records.find((record) => record.event === "upstream.write");
  expect(write).toMatchObject({
    methods: ["Email/set"],
    confirmed: true,
    http_status: 200,
  });
  expect(JSON.stringify(records)).not.toMatch(
    /secret-id|private|refresh-synthetic/,
  );
});
