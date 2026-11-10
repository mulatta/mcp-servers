import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import channelVideos from "../fixtures/library/channel-videos.json";
import { accountPage } from "../fixtures/account.ts";
import { normalize } from "../../src/youtube/normalize.ts";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { createServer, type ReadInput } from "../../src/server.ts";
import { libraryServer } from "../fixtures/library-server.ts";
import { Paginator } from "../../src/pagination.ts";

const channel = "UCfixture000000000000001";

test("channel uploads normalize renderers and lockups with publish labels", () => {
  const page = normalize(channelVideos, "channel_videos");
  expect(page.items).toEqual([
    {
      video_id: "v0000000011",
      title: "Fixture",
      url: "https://www.youtube.com/watch?v=v0000000011",
      // The channel is the requested one; lockup rows here hold views, not a name.
      channel_name: null,
      availability: "available",
      watched_percent: 50,
      duration_seconds: null,
      published_text: "2 days ago",
    },
    {
      video_id: "v0000000012",
      title: "Fixture",
      url: "https://www.youtube.com/watch?v=v0000000012",
      channel_name: null,
      availability: "available",
      watched_percent: null,
      duration_seconds: null,
      published_text: "3 weeks ago",
    },
  ]);
  expect(page.continuation).toBe("fixture-next");
});

test("channel uploads browse the channel's Videos tab", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      bodies.push(body);
      return Response.json(
        body.browseId === "SPaccount_advanced"
          ? accountPage("UCaaaaaaaaaaaaaaaaaaaaaa")
          : channelVideos,
      );
    },
  });
  const signal = new AbortController().signal;
  try {
    const session = await YoutubeClient.connect(
      "SAPISID=fixture",
      signal,
      (req) => fetch(new Request(`http://127.0.0.1:${server.port}/`, req)),
    );
    await session.value.page(
      "youtube_get_channel_videos",
      { limit: 5, channel_id: channel },
      signal,
    );
    expect(bodies.at(-1)).toMatchObject({
      browseId: channel,
      params: "EgZ2aWRlb3PyBgQKAjoA",
    });
  } finally {
    server.stop(true);
  }
});

async function connect() {
  const f = libraryServer();
  const calls: ReadInput[] = [];
  const pager = new Paginator(f.sessions);
  const server = createServer((name, input, signal) => {
    calls.push(input);
    return pager.read(name, input, signal);
  });
  const client = new Client({ name: "channel-videos-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return {
    calls,
    client,
    async close() {
      await client.close();
      await server.close();
      f.close();
    },
  };
}

test("channel IDs other than UC plus 22 characters are rejected before backend access", async () => {
  const c = await connect();
  try {
    for (const channel_id of [
      "UCshort",
      "@handle",
      `https://www.youtube.com/channel/${channel}`,
      `PL${channel.slice(2)}`,
    ]) {
      const result = await c.client.callTool({
        name: "youtube_get_channel_videos",
        arguments: { channel_id },
      });
      expect(result.isError).toBe(true);
    }
    expect(c.calls).toEqual([]);
  } finally {
    await c.close();
  }
});

test("a channel cursor cannot continue another channel", async () => {
  const c = await connect();
  try {
    const first = await c.client.callTool({
      name: "youtube_get_channel_videos",
      arguments: { channel_id: channel, limit: 1 },
    });
    const cursor = (first.structuredContent as { next_cursor: string })
      .next_cursor;
    expect(typeof cursor).toBe("string");
    const other = await c.client.callTool({
      name: "youtube_get_channel_videos",
      arguments: { channel_id: "UCfixture000000000000002", limit: 1, cursor },
    });
    expect(JSON.stringify(other)).toContain("CURSOR_INVALID");
  } finally {
    await c.close();
  }
});
