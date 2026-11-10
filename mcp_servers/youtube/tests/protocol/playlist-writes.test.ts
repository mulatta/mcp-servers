import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import type { WriteGroup } from "../../src/config.ts";
import { libraryServer } from "../fixtures/library-server.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";

const created = "PLfixture000000000000000000000001";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Write = { path: string; body: Record<string, unknown> };
async function connect(
  options: {
    writes?: WriteGroup[];
    onWrite?: (
      path: string,
      body: Record<string, unknown>,
    ) => Response | Promise<Response>;
    timeoutMs?: number;
  } = {},
) {
  const writes: Write[] = [];
  const f = libraryServer({
    onWrite: (path, body) => {
      writes.push({ path, body });
      return options.onWrite
        ? options.onWrite(path, body)
        : Response.json(
            path.endsWith("/playlist/create")
              ? { playlistId: created }
              : path.endsWith("/browse/edit_playlist")
                ? { status: "STATUS_SUCCEEDED" }
                : {},
          );
    },
  });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const diagnostics = captureDiagnostics();
  const server = createServer(backend.reader, {
    writer: backend.writer,
    writes: new Set(options.writes ?? ["playlist"]),
    logger: diagnostics.logger,
    timeoutMs: options.timeoutMs,
  });
  const client = new Client({ name: "playlist-writes-test", version: "1" });
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
    const text = JSON.stringify(result);
    return { result, text, code: /\\"code\\":\\"(\w+)\\"/.exec(text)?.[1] };
  };
  return { client, call, writes, f, diagnostics };
}

test("write tools are absent and unreachable unless their group is enabled", async () => {
  for (const groups of [
    [],
    ["rating"],
    ["subscription", "notification"],
  ] as WriteGroup[][]) {
    const { client, call, writes } = await connect({ writes: groups });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("youtube_create_playlist");
    expect(names).not.toContain("youtube_delete_playlist");
    expect(names).not.toContain("youtube_add_to_playlist");
    expect(names).not.toContain("youtube_remove_from_playlist");
    const { result } = await call("youtube_delete_playlist", {
      playlist_id: created,
    });
    expect(result.isError).toBe(true);
    expect(writes).toEqual([]);
  }
});

test("enabled playlist tools declare write and destructive annotations", async () => {
  const { client } = await connect();
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  expect(tools.youtube_create_playlist?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  });
  expect(tools.youtube_delete_playlist?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});

test("only user playlist IDs can be deleted, checked before any request", async () => {
  const { call, writes, f } = await connect();
  for (const playlist_id of [
    "WL",
    "LL",
    "RDfixture00000000000",
    "OLAKfixture000000000000000000000000000",
    "UUfixture0000000000000000",
    "PL",
    `https://www.youtube.com/playlist?list=${created}`,
    `${created}!`,
  ]) {
    const { result } = await call("youtube_delete_playlist", { playlist_id });
    expect(result.isError).toBe(true);
  }
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("invalid create input is rejected before any request", async () => {
  const { call, writes, f } = await connect();
  for (const args of [
    {},
    { title: "" },
    { title: "x".repeat(151) },
    { title: "Fixture", privacy: "SECRET" },
    { title: "Fixture", description: "x".repeat(5001) },
    { title: "Fixture", video_ids: ["v0000000001"] },
  ]) {
    const { result } = await call("youtube_create_playlist", args);
    expect(result.isError).toBe(true);
  }
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("create sends one private playlist request and returns the new ID", async () => {
  const { call, writes } = await connect();
  const { result } = await call("youtube_create_playlist", {
    title: "Fixture",
  });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: created,
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/playlist/create",
      body: expect.objectContaining({
        title: "Fixture",
        privacyStatus: "PRIVATE",
        videoIds: [],
      }),
    },
  ]);
});

test("delete sends the playlist ID in the request body", async () => {
  const { call, writes } = await connect();
  const { result } = await call("youtube_delete_playlist", {
    playlist_id: created,
  });
  expect(result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: created,
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/playlist/delete",
      body: expect.objectContaining({ playlistId: created }),
    },
  ]);
});

test("a rejected write is reported as rejected and never retried", async () => {
  for (const [status, code] of [
    [401, "AUTH_REQUIRED"],
    [403, "PLAYLIST_UNAVAILABLE"],
  ] as const) {
    const { call, writes } = await connect({
      onWrite: () => new Response(null, { status }),
    });
    expect(
      (await call("youtube_delete_playlist", { playlist_id: created })).code,
    ).toBe(code);
    expect(writes).toHaveLength(1);
  }
});

test("a write that may have landed is reported as unknown, never as a plain failure", async () => {
  const cases: [
    string,
    (
      path: string,
      body: Record<string, unknown>,
    ) => Response | Promise<Response>,
  ][] = [
    ["server error", () => new Response(null, { status: 500 })],
    ["unparsable success", () => new Response("not json", { status: 200 })],
    ["success without the new ID", () => Response.json({})],
    [
      "connection dropped mid-response",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"playlistId":'));
              controller.error(new Error("reset"));
            },
          }),
        ),
    ],
  ];
  for (const [label, onWrite] of cases) {
    const { call, writes } = await connect({ onWrite });
    const { code } = await call("youtube_create_playlist", { title: label });
    expect({ label, code }).toEqual({ label, code: "WRITE_OUTCOME_UNKNOWN" });
    expect(writes).toHaveLength(1);
  }
});

test("a write cut off by the deadline after dispatch is unknown", async () => {
  const { call, writes } = await connect({
    timeoutMs: 200,
    onWrite: () => new Promise<Response>(() => {}),
  });
  expect(
    (await call("youtube_delete_playlist", { playlist_id: created })).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN");
  expect(writes).toHaveLength(1);
});

test("write diagnostics record the tool and outcome but no identifiers", async () => {
  const { call, diagnostics } = await connect();
  await call("youtube_create_playlist", { title: "Fixture title" });
  const text = JSON.stringify(await diagnostics.finish());
  expect(text).toContain("youtube_create_playlist");
  expect(text).not.toContain(created);
  expect(text).not.toContain("Fixture title");
});

// Observed live: newly created playlists get "PL" plus 11 characters, older ones
// "PL" plus 32. Both must round-trip through create and delete.
test("short and long user playlist IDs both round-trip", async () => {
  for (const id of ["PLfixture0001", "PLfixture00000000000000000000001"]) {
    const { call, writes } = await connect({
      onWrite: (path) =>
        Response.json(
          path.endsWith("/playlist/create") ? { playlistId: id } : {},
        ),
    });
    const made = await call("youtube_create_playlist", { title: "Fixture" });
    expect(made.result.structuredContent).toMatchObject({ playlist_id: id });
    const gone = await call("youtube_delete_playlist", { playlist_id: id });
    expect(gone.result.structuredContent).toMatchObject({ playlist_id: id });
    expect(writes).toHaveLength(2);
  }
});

const videos = ["v0000000001", "v0000000002"];

test("adding and removing accept user playlists and Watch Later only", async () => {
  const { call, writes, f } = await connect();
  for (const name of [
    "youtube_add_to_playlist",
    "youtube_remove_from_playlist",
  ])
    for (const playlist_id of [
      "LL",
      "RDfixture00000000000",
      "UUfixture0000000000000000",
      "wl",
      "PL",
    ]) {
      const { result } = await call(name, { playlist_id, video_ids: videos });
      expect(result.isError).toBe(true);
    }
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("video lists that are empty, oversized, malformed or repeated are rejected", async () => {
  const { call, writes, f } = await connect();
  for (const video_ids of [
    [],
    Array.from({ length: 51 }, (_, i) => `v${String(i).padStart(10, "0")}`),
    ["short"],
    ["https://youtu.be/v0000000001"],
    ["v0000000001", "v0000000001"],
  ]) {
    for (const name of [
      "youtube_add_to_playlist",
      "youtube_remove_from_playlist",
    ]) {
      const { result } = await call(name, { playlist_id: created, video_ids });
      expect(result.isError).toBe(true);
    }
  }
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("add and remove send one edit with an action per video", async () => {
  const { call, writes } = await connect();
  const added = await call("youtube_add_to_playlist", {
    playlist_id: created,
    video_ids: videos,
  });
  expect(added.result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: created,
    video_ids: videos,
  });
  const removed = await call("youtube_remove_from_playlist", {
    playlist_id: "WL",
    video_ids: videos,
  });
  expect(removed.result.structuredContent).toMatchObject({
    playlist_id: "WL",
    video_ids: videos,
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/browse/edit_playlist",
      body: expect.objectContaining({
        playlistId: created,
        actions: videos.map((id) => ({
          action: "ACTION_ADD_VIDEO",
          addedVideoId: id,
        })),
      }),
    },
    {
      path: "/youtubei/v1/browse/edit_playlist",
      body: expect.objectContaining({
        playlistId: "WL",
        actions: videos.map((id) => ({
          action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID",
          removedVideoId: id,
        })),
      }),
    },
  ]);
});

test("an edit without a success status is unknown, and a refusal is not retried", async () => {
  for (const [label, response, code] of [
    ["no status", () => Response.json({}), "WRITE_OUTCOME_UNKNOWN"],
    [
      "failed status",
      () => Response.json({ status: "STATUS_FAILED" }),
      "WRITE_OUTCOME_UNKNOWN",
    ],
    [
      "forbidden",
      () => new Response(null, { status: 403 }),
      "PLAYLIST_UNAVAILABLE",
    ],
  ] as const) {
    const { call, writes } = await connect({ onWrite: response });
    const { code: got } = await call("youtube_add_to_playlist", {
      playlist_id: created,
      video_ids: videos,
    });
    expect({ label, got }).toEqual({ label, got: code });
    expect(writes).toHaveLength(1);
  }
});

test("removing videos is declared destructive, adding is not", async () => {
  const { client } = await connect();
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [tool.name, tool]),
  );
  expect(tools.youtube_add_to_playlist?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  expect(tools.youtube_remove_from_playlist?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
});
