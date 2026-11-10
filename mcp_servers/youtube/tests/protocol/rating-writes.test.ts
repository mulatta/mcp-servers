import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import type { WriteGroup } from "../../src/config.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const video = "v0000000001";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Shape observed live: the new rating comes back as a likeStatusEntity mutation.
const status = (likeStatus: string) => ({
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        {
          type: "ENTITY_MUTATION_TYPE_REPLACE",
          payload: { likeStatusEntity: { key: "fixture", likeStatus } },
        },
      ],
    },
  },
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
        Response.json(
          status(path.endsWith("/like/like") ? "LIKE" : "INDIFFERENT"),
        )
      );
    },
  });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const server = createServer(backend.reader, {
    writer: backend.writer,
    writes: new Set(options.writes ?? ["rating"]),
  });
  const client = new Client({ name: "rating-writes-test", version: "1" });
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

test("rating tools are absent and unreachable unless the rating group is enabled", async () => {
  for (const groups of [
    [],
    ["playlist"],
    ["subscription", "notification"],
  ] as WriteGroup[][]) {
    const { client, call, writes } = await connect({ writes: groups });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("youtube_like_video");
    expect(names).not.toContain("youtube_remove_rating");
    expect((await call("youtube_like_video", { video_id: video })).code).toBe(
      "invalid",
    );
    expect(writes).toEqual([]);
  }
});

test("there is no dislike tool", async () => {
  const { client } = await connect({ writes: ["rating"] });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names.filter((name) => /dislike/.test(name))).toEqual([]);
});

test("malformed video IDs are rejected before any request", async () => {
  const { call, writes, f } = await connect();
  for (const video_id of [
    "",
    "short",
    "https://youtu.be/v0000000001",
    "v00000000012",
  ])
    for (const name of ["youtube_like_video", "youtube_remove_rating"])
      expect((await call(name, { video_id })).code).toBe("invalid");
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("like and remove send one request each with the video as target", async () => {
  const { call, writes } = await connect();
  const liked = await call("youtube_like_video", { video_id: video });
  expect(liked.result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    video_id: video,
    rating: "like",
  });
  const removed = await call("youtube_remove_rating", { video_id: video });
  expect(removed.result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    video_id: video,
    rating: "none",
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/like/like",
      body: expect.objectContaining({ target: { videoId: video } }),
    },
    {
      path: "/youtubei/v1/like/removelike",
      body: expect.objectContaining({ target: { videoId: video } }),
    },
  ]);
});

test("a rating is confirmed only by the matching like status", async () => {
  for (const [label, response] of [
    ["no mutation", () => Response.json({})],
    ["other status", () => Response.json(status("INDIFFERENT"))],
    ["dislike status", () => Response.json(status("DISLIKE"))],
  ] as const) {
    const { call, writes } = await connect({ onWrite: response });
    expect({
      label,
      code: (await call("youtube_like_video", { video_id: video })).code,
    }).toEqual({
      label,
      code: "WRITE_OUTCOME_UNKNOWN",
    });
    expect(writes).toHaveLength(1);
  }
});

test("a refused rating is reported as refused and not retried", async () => {
  const { call, writes } = await connect({
    onWrite: () => new Response(null, { status: 401 }),
  });
  expect((await call("youtube_remove_rating", { video_id: video })).code).toBe(
    "AUTH_REQUIRED",
  );
  expect(writes).toHaveLength(1);
});

test("removing a rating is declared destructive, liking is not", async () => {
  const { client } = await connect();
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  expect(tools.youtube_like_video?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(tools.youtube_remove_rating?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});
