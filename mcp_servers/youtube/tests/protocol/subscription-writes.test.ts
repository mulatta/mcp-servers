import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import type { WriteGroup } from "../../src/config.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const channel = "UCfixture000000000000009";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Shape observed live: the subscribe button update names the channel and its new state.
const button = (channelId: string, subscribed: boolean) => ({
  actions: [{ updateSubscribeButtonAction: { channelId, subscribed } }],
});

type Write = { path: string; body: Record<string, unknown> };
async function connect(
  options: { writes?: WriteGroup[]; onWrite?: (path: string) => Response } = {},
) {
  const writes: Write[] = [];
  const f = libraryServer({
    onWrite: (path, body) => {
      writes.push({ path, body });
      return (
        options.onWrite?.(path) ??
        Response.json(button(channel, path.endsWith("/subscribe")))
      );
    },
  });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const server = createServer(backend.reader, {
    writer: backend.writer,
    writes: new Set(options.writes ?? ["subscription"]),
  });
  const client = new Client({ name: "subscription-writes-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    f.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[])?.[0]?.text ?? "";
    return {
      result,
      code: result.isError
        ? (/"code":"(\w+)"/.exec(text)?.[1] ?? "invalid")
        : "ok",
    };
  };
  return { client, call, writes, f };
}

test("subscription tools are absent and unreachable unless their group is enabled", async () => {
  for (const groups of [
    [],
    ["playlist", "rating"],
    ["notification"],
  ] as WriteGroup[][]) {
    const { client, call, writes } = await connect({ writes: groups });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("youtube_subscribe");
    expect(names).not.toContain("youtube_unsubscribe");
    expect(
      (await call("youtube_unsubscribe", { channel_id: channel })).code,
    ).toBe("invalid");
    expect(writes).toEqual([]);
  }
});

test("only UC channel IDs are accepted, checked before any request", async () => {
  const { call, writes, f } = await connect();
  for (const channel_id of [
    "@handle",
    "UCshort",
    `https://www.youtube.com/channel/${channel}`,
    `HC${channel.slice(2)}`,
  ])
    for (const name of ["youtube_subscribe", "youtube_unsubscribe"])
      expect((await call(name, { channel_id })).code).toBe("invalid");
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("subscribe and unsubscribe send one request naming the channel", async () => {
  const { call, writes } = await connect();
  expect(
    (await call("youtube_subscribe", { channel_id: channel })).result
      .structuredContent,
  ).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    channel_id: channel,
    subscribed: true,
  });
  expect(
    (await call("youtube_unsubscribe", { channel_id: channel })).result
      .structuredContent,
  ).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    channel_id: channel,
    subscribed: false,
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/subscription/subscribe",
      body: expect.objectContaining({
        channelIds: [channel],
        params: "EgIIAhgA",
      }),
    },
    {
      path: "/youtubei/v1/subscription/unsubscribe",
      body: expect.objectContaining({
        channelIds: [channel],
        params: "CgIIAhgA",
      }),
    },
  ]);
});

test("a change is confirmed only by a button update for that channel and state", async () => {
  for (const [label, response] of [
    ["no update", () => Response.json({})],
    [
      "other channel",
      () => Response.json(button("UCfixture000000000000001", true)),
    ],
    ["wrong state", () => Response.json(button(channel, false))],
  ] as const) {
    const { call, writes } = await connect({ onWrite: response });
    expect({
      label,
      code: (await call("youtube_subscribe", { channel_id: channel })).code,
    }).toEqual({
      label,
      code: "WRITE_OUTCOME_UNKNOWN",
    });
    expect(writes).toHaveLength(1);
  }
});

test("unsubscribing is declared destructive, subscribing is not", async () => {
  const { client } = await connect();
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  expect(tools.youtube_subscribe?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(tools.youtube_unsubscribe?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});
