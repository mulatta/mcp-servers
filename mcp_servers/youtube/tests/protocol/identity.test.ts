import { expect, test } from "bun:test";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { acquireCookies } from "../../src/auth/cdp.ts";
import { SessionProvider } from "../../src/auth/session.ts";
import { cdpFixture } from "../fixtures/cdp.ts";
import { accountPage } from "../fixtures/account.ts";

const first = "UCaaaaaaaaaaaaaaaaaaaaaa";
const second = "UCbbbbbbbbbbbbbbbbbbbbbb";

test("real YouTube.js parser identifies and pins account over local HTTP and CDP", async () => {
  const browser = cdpFixture();
  let id: string | null = first;
  let authenticated = false;
  let now = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      expect(req.method).toBe("POST");
      expect(body.browseId).toBe("SPaccount_advanced");
      authenticated =
        req.headers.get("cookie") === "SAPISID=fixture-secret" &&
        (req.headers.get("authorization")?.startsWith("SAPISIDHASH ") ?? false);
      return Response.json(accountPage(id));
    },
  });
  const provider = new SessionProvider(
    async (signal) =>
      YoutubeClient.connect(
        await acquireCookies(browser.url, signal),
        signal,
        (request) =>
          fetch(new Request(`http://127.0.0.1:${upstream.port}/`, request)),
      ),
    () => now,
  );
  try {
    expect((await provider.get(new AbortController().signal)).accountId).toBe(
      first,
    );
    expect(authenticated).toBe(true);
    id = second;
    now = 300_000;
    await expect(
      provider.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    id = first;
    await expect(
      provider.get(new AbortController().signal),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(browser.discoveries).toBe(2);
  } finally {
    browser.close();
    upstream.stop(true);
  }
});

test("cookies without a stable identity are not authenticated", async () => {
  await expect(
    YoutubeClient.connect(
      "SAPISID=fixture-secret",
      new AbortController().signal,
      async () => Response.json(accountPage(null)),
    ),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
});
