import { expect, test } from "bun:test";
import { acquireCookies } from "../../src/auth/cdp.ts";
import { readConfig } from "../../src/config.ts";
import { cdpFixture, cookie } from "../fixtures/cdp.ts";

const signal = () => new AbortController().signal;

test("operator endpoint rejects credentials, query, fragments, and non-http schemes", () => {
  expect(readConfig({}).cdpUrl).toBe("http://127.0.0.1:9222/");
  for (const url of [
    "file:///tmp",
    "http://user:secret@localhost",
    "http://localhost/?secret",
    "http://localhost/#secret",
  ]) {
    expect(() => readConfig({ YOUTUBE_CDP_URL: url })).toThrow();
  }
});

test("scoped HttpOnly cookies use only default context and disconnect without mutations", async () => {
  const f = cdpFixture();
  try {
    expect(await acquireCookies(f.url, signal())).toBe(
      "SAPISID=fixture-secret",
    );
    await Bun.sleep(10);
    expect(f.connections).toBe(0);
    expect(f.forbidden).toBe(false);
    expect(
      f.commands.find((x) => x.method === "Target.attachToTarget")?.params,
    ).toEqual({ targetId: "default", flatten: true });
    expect(
      f.commands.find((x) => x.method === "Network.getCookies"),
    ).toMatchObject({
      sessionId: "session",
      params: { urls: ["https://www.youtube.com/"] },
    });
    expect(f.commands.at(-1)?.method).toBe("Target.detachFromTarget");
  } finally {
    f.close();
  }
});

test("cookie applicability rejects unrelated, expired, wrong-path and partition cookies", async () => {
  const f = cdpFixture({
    cookies: [
      cookie(),
      cookie({ name: "host", domain: "www.youtube.com" }),
      cookie({
        name: "partition",
        partitionKey: {
          topLevelSite: "https://youtube.com",
          hasCrossSiteAncestor: false,
        },
      }),
      cookie({ name: "domain", domain: "youtube.com.evil.test" }),
      cookie({ name: "hostonly", domain: "youtube.com" }),
      cookie({ name: "path", path: "/account" }),
      cookie({ name: "expired", expires: 1 }),
      cookie({
        name: "partitionbad",
        partitionKey: {
          topLevelSite: "https://evil.test",
          hasCrossSiteAncestor: false,
        },
      }),
      cookie({ name: "opaque", partitionKeyOpaque: true }),
      cookie({
        name: "ancestor",
        partitionKey: {
          topLevelSite: "https://youtube.com",
          hasCrossSiteAncestor: true,
        },
      }),
      cookie({ name: "injection", value: "secret; OTHER=bad" }),
      cookie({ name: "newline", value: "secret\r\n" }),
    ],
  });
  try {
    expect(await acquireCookies(f.url, signal())).toBe(
      "SAPISID=fixture-secret; host=fixture-secret; partition=fixture-secret",
    );
  } finally {
    f.close();
  }
});

for (const options of [
  { authority: "evil.test:9222" },
  { redirect: true },
  { noPage: true },
  { closeEarly: true },
  { malformed: true },
])
  test(`safe discovery failure ${JSON.stringify(options)}`, async () => {
    const f = cdpFixture(options);
    try {
      await expect(acquireCookies(f.url, signal())).rejects.toMatchObject({
        code: "BROWSER_UNAVAILABLE",
      });
      await Bun.sleep(10);
      expect(f.connections).toBe(0);
      expect(f.forbidden).toBe(false);
    } finally {
      f.close();
    }
  });

test("stalled CDP cancels and closes its socket", async () => {
  const f = cdpFixture({ stall: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await expect(
      acquireCookies(f.url, controller.signal),
    ).rejects.toBeDefined();
    await Bun.sleep(10);
    expect(f.connections).toBe(0);
    expect(f.forbidden).toBe(false);
  } finally {
    clearTimeout(timer);
    f.close();
  }
});

test("no usable cookies requires manual login", async () => {
  const f = cdpFixture({ cookies: [] });
  try {
    await expect(acquireCookies(f.url, signal())).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  } finally {
    f.close();
  }
});
