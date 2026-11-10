import { afterEach, expect, test } from "bun:test";
import { startHttp } from "../../src/http.ts";
import { createReader } from "../../src/reader.ts";
import { toolNames } from "../../src/server.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";
import { callTool } from "../fixtures/http.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// One process-wide reader is what lets separate HTTP clients share the browser session.
async function serve(pages: number[]) {
  const f = libraryServer({ pages });
  cleanups.push(() => f.close());
  const server = await startHttp(
    createReader({ cdpUrl: f.browser.url, network: f.network }),
    {
      hostname: "127.0.0.1",
      port: 0,
      token,
      allowedHosts: ["127.0.0.1"],
      logger: captureDiagnostics().logger,
    },
  );
  cleanups.push(() => server.stop());
  return { f, url: server.url };
}

test("concurrent HTTP clients share one browser refresh and account", async () => {
  const { f, url } = await serve([4]);
  const calls = [...toolNames, ...toolNames].map((name) =>
    callTool(url, token, name, {
      limit: 1,
      ...(name === "youtube_get_playlist" ? { playlist_id: "PLfixture" } : {}),
    }),
  );
  const results = await Promise.all(calls);
  expect(results.map((result) => result.isError ?? false)).toEqual(
    results.map(() => false),
  );
  expect(f.browser.discoveries).toBe(1);
  expect(
    new Set(results.map((result) => result.structuredContent?.account_id)).size,
  ).toBe(1);
});

test("a cursor followed by several clients at once is computed upstream once", async () => {
  const { f, url } = await serve([1, 1]);
  const first = await callTool(url, token, "youtube_get_watch_later", {
    limit: 1,
  });
  const cursor = first.structuredContent?.next_cursor;
  expect(typeof cursor).toBe("string");
  const readsBefore = f.reads;
  const followers = await Promise.all(
    Array.from({ length: 3 }, () =>
      callTool(url, token, "youtube_get_watch_later", { limit: 1, cursor }),
    ),
  );
  expect(followers.every((result) => !result.isError)).toBe(true);
  expect(followers[1]?.structuredContent).toEqual(
    followers[0]?.structuredContent,
  );
  expect(followers[2]?.structuredContent).toEqual(
    followers[0]?.structuredContent,
  );
  expect(f.reads - readsBefore).toBe(1);
  expect(f.browser.discoveries).toBe(1);
});
