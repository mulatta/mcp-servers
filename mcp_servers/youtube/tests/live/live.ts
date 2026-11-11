import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveEnv } from "./env.ts";

/**
 * Live tests drive the real server over stdio against a signed-in browser.
 * They run only when asked: YOUTUBE_LIVE=1 on the command line, against the
 * browser that the git-ignored .env.test (loaded by bun test) points at.
 * Writes additionally need YOUTUBE_LIVE_WRITES=1 and both account pins.
 * Assertions compare booleans and counts only, so a failure never prints
 * IDs or titles.
 */
export const env = liveEnv(process.env);
export const { cdpUrl, accountId, personalAccountId, reads, writes } = env;
export const timeout = 180_000;
export const prefix = "youtube-mcp live test";

type Result = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: unknown;
};
export type Live = {
  call(name: string, args?: Record<string, unknown>): Promise<Result>;
  ok(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  code(result: Result): string;
  close(): Promise<void>;
};

// YOUTUBE_LIVE_LOG names a file that collects the servers' JSONL logs, which
// carry stages and safe codes, never IDs; it explains failed writes.
const logFile = process.env.YOUTUBE_LIVE_LOG;
const serverLog = () => (logFile ? openSync(logFile, "a") : "ignore");

function serverEnv(extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "",
    YOUTUBE_CDP_URL: cdpUrl,
    YOUTUBE_LOG_LEVEL: logFile ? "debug" : "error",
    ...(writes ? { YOUTUBE_WRITES: "all" } : {}),
    ...extra,
  };
}

function safeCode(result: Result) {
  return result.isError
    ? (/"code":"(\w+)"/.exec(
        (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "",
      )?.[1] ?? "UNKNOWN")
    : "OK";
}

function wrap(
  call: (name: string, args: Record<string, unknown>) => Promise<Result>,
  close: () => Promise<void>,
): Live {
  return {
    call: (name, args = {}) => call(name, args),
    code: safeCode,
    async ok(name, args = {}) {
      const result = await call(name, args);
      // Only the safe error code reaches the assertion message.
      if (result.isError)
        throw new Error(`${name} failed with ${safeCode(result)}`);
      return result.structuredContent ?? {};
    },
    close,
  };
}

export type HttpLive = Live & {
  url: URL;
  token: string;
  rpc(method: string, params: unknown, token?: string): Promise<Response>;
};

/**
 * Starts the server with the HTTP transport, a throwaway token and a free
 * loopback port, and talks JSON-RPC to it directly, as Hermes does.
 */
export async function connectHttp(): Promise<HttpLive> {
  const dir = await mkdtemp(join(tmpdir(), "youtube-live-http-"));
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await writeFile(join(dir, "token"), `${token}\n`, { mode: 0o600 });
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const port = probe.port;
  await probe.stop(true);
  const server = Bun.spawn(
    [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname],
    {
      env: serverEnv({
        YOUTUBE_TRANSPORT: "http",
        YOUTUBE_HTTP_PORT: String(port),
        YOUTUBE_HTTP_TOKEN_FILE: join(dir, "token"),
      }),
      stdin: "ignore",
      stdout: "ignore",
      stderr: serverLog(),
    },
  );
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  let id = 0;
  const rpc = (method: string, params: unknown, bearer = token) =>
    fetch(url, {
      method: "POST",
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(url, { method: "POST" });
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const body = (await (
      await rpc("tools/call", { name, arguments: args })
    ).json()) as {
      result?: Result;
    };
    return body.result ?? { isError: true };
  };
  const live = wrap(call, async () => {
    server.kill("SIGTERM");
    await server.exited;
    await rm(dir, { recursive: true, force: true });
  });
  return { ...live, url, token, rpc };
}

export async function connect(url = cdpUrl): Promise<Live> {
  const client = new Client({ name: "youtube-live-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../../src/index.ts", import.meta.url).pathname],
      env: serverEnv({ YOUTUBE_CDP_URL: url }),
      stderr: serverLog(),
    }),
    { timeout: 30_000 },
  );
  return wrap(
    (name, args) =>
      client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000,
      }) as Promise<Result>,
    () => client.close(),
  );
}

type Item = Record<string, unknown>;
export const items = (result: Record<string, unknown>) =>
  (result.items ?? []) as Item[];

/** Reads every page of a list tool, up to a page bound. */
export async function all(
  live: Live,
  name: string,
  args: Record<string, unknown> = {},
  pages = 40,
): Promise<{ items: Item[]; complete: boolean }> {
  const out: Item[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < pages; page++) {
    const result = await live.ok(name, {
      ...args,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    out.push(...items(result));
    cursor = (result.next_cursor as string | null) ?? undefined;
    if (!cursor) return { items: out, complete: true };
  }
  return { items: out, complete: false };
}

export const ids = (list: Item[], field = "video_id") =>
  list.map((item) => item[field] as string);
export const sameOrder = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Polls until YouTube's lists reflect a write; returns whether they did. */
export async function until(
  check: () => Promise<boolean>,
  seconds = 40,
): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return true;
    } catch {
      // A newly created target may briefly read as unavailable.
    }
    await Bun.sleep(1500);
  }
  return false;
}

/**
 * Long-lived public channels the tests follow, and one they never follow so
 * a refusal can be checked. Reading their uploads needs no subscription, so
 * tests can take videos from them on an empty account.
 */
export const publicChannels = [
  "UCK8sQmJBp8GCxrOtXWBpyEA", // Google
  "UC_x5XG1OV2P6uZZ5FSM9Ttw", // Google for Developers
];
export const outsider = "UCBR8-60-B28hp2BmDPdntcQ"; // YouTube

/** Distinct public uploads of a public channel, used as test videos. */
export async function sampleVideos(live: Live, count: number) {
  const uploads = [
    ...new Set(
      ids(
        (
          await all(
            live,
            "youtube_get_channel_videos",
            { channel_id: publicChannels[0] },
            Math.ceil(count / 100) + 1,
          )
        ).items,
      ).filter(Boolean),
    ),
  ];
  if (uploads.length < count) throw new Error("too few test videos");
  return uploads.slice(0, count);
}

/**
 * Confirms the browser is signed into the pinned account before anything
 * else runs. The error names neither account.
 */
export async function verifyAccount(live: Live) {
  if (!accountId) return;
  const result = await live.ok("youtube_list_playlists", { limit: 1 });
  if (personalAccountId && result.account_id === personalAccountId)
    throw new Error(
      "the browser is signed into YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID; stopping",
    );
  if (result.account_id !== accountId)
    throw new Error(
      "the browser is signed into another account than YOUTUBE_LIVE_ACCOUNT_ID; stopping",
    );
  confirmed.add(live);
}

const confirmed = new WeakSet<Live>();
/**
 * Cleanup writes too, so it runs only on a connection whose account was
 * confirmed; a failed check must not lead to edits on another account.
 */
export const mayClean = (live: Live | undefined) =>
  live !== undefined && confirmed.has(live);
