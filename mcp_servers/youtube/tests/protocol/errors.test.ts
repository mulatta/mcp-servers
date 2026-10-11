import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Reader } from "../../src/server.ts";

async function connected(reader: Reader, timeoutMs = 30_000) {
  const server = createServer(reader, { timeoutMs });
  const client = new Client({ name: "errors-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("invalid input and unknown tools never call backend", async () => {
  let calls = 0;
  const fixture = await connected(async () => {
    calls++;
    return {};
  });
  try {
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { limit: 2.5 },
      { cookie: "secret" },
      { endpoint: "https://example.com" },
    ]) {
      const result = await fixture.client.callTool({
        name: "youtube_get_watch_later",
        arguments: args,
      });
      expect(result.isError).toBe(true);
    }
    const badId = await fixture.client.callTool({
      name: "youtube_get_playlist",
      arguments: { playlist_id: "https://youtube.com/playlist?list=WL" },
    });
    expect(badId.isError).toBe(true);
    const unknown = await fixture.client.callTool({
      name: "youtube_delete_playlist",
      arguments: {},
    });
    expect(unknown.isError).toBe(true);
    expect(calls).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("unexpected backend errors do not expose secrets", async () => {
  const fixture = await connected(async () => {
    throw new Error(
      "Cookie: SID=DO_NOT_LEAK; ws://private/devtools/browser/secret",
    );
  });
  try {
    const result = await fixture.client.callTool({
      name: "youtube_get_watch_later",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("DO_NOT_LEAK");
    expect(JSON.stringify(result)).not.toContain("devtools");
  } finally {
    await fixture.close();
  }
});

test("deadline aborts backend even if it never settles", async () => {
  let signal: AbortSignal | undefined;
  const fixture = await connected(async (_name, _input, current) => {
    signal = current;
    return new Promise(() => {});
  }, 20);
  try {
    const result = await fixture.client.callTool({
      name: "youtube_get_watch_later",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("TIMEOUT");
    expect(signal?.aborted).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("client cancellation aborts backend", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let aborted!: () => void;
  const stopped = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const fixture = await connected(async (_name, _input, signal) => {
    signal.addEventListener("abort", aborted, { once: true });
    started();
    return new Promise(() => {});
  });
  const controller = new AbortController();
  try {
    const pending = fixture.client.callTool(
      { name: "youtube_get_watch_history", arguments: {} },
      undefined,
      { signal: controller.signal },
    );
    const failure = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await ready;
    controller.abort();
    expect(await failure).not.toBeNull();
    await stopped;
  } finally {
    await fixture.close();
  }
});
