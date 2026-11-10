import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const playlist = "PLfixture0001";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Write = { path: string; body: Record<string, unknown> };
// The fixture playlist serves videos v…00 to v…12 with set IDs set-0, set-1, … in order.
async function connect(
  options: { pages?: number[]; onWrite?: () => Response } = {},
) {
  const writes: Write[] = [];
  const f = libraryServer({
    pages: options.pages ?? [3, 3],
    onWrite: (path, body) => {
      writes.push({ path, body });
      return (
        options.onWrite?.() ?? Response.json({ status: "STATUS_SUCCEEDED" })
      );
    },
  });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const server = createServer(backend.reader, {
    writer: backend.writer,
    writes: new Set(["playlist"]),
  });
  const client = new Client({ name: "playlist-edits-test", version: "1" });
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
  const browses = () =>
    f.paths.filter((path) => path.endsWith("/browse")).length;
  return { call, writes, f, browses };
}
const v = (n: number) => `v${String(n).padStart(10, "0")}`;

test("update accepts only user playlists and needs a title or description", async () => {
  const { call, writes, f } = await connect();
  for (const args of [
    { playlist_id: playlist },
    { playlist_id: "WL", title: "Fixture" },
    { playlist_id: "LL", title: "Fixture" },
    { playlist_id: playlist, title: "" },
    { playlist_id: playlist, title: "x".repeat(151) },
    { playlist_id: playlist, description: "x".repeat(5001) },
    { playlist_id: playlist, title: "Fixture", privacy: "PUBLIC" },
  ])
    expect((await call("youtube_update_playlist", args)).code).toBe("invalid");
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("update sends one edit naming each changed field", async () => {
  const { call, writes } = await connect();
  const { result } = await call("youtube_update_playlist", {
    playlist_id: playlist,
    title: "New title",
    description: "",
  });
  expect(result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: playlist,
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/browse/edit_playlist",
      body: expect.objectContaining({
        playlistId: playlist,
        actions: [
          { action: "ACTION_SET_PLAYLIST_NAME", playlistName: "New title" },
          {
            action: "ACTION_SET_PLAYLIST_DESCRIPTION",
            playlistDescription: "",
          },
        ],
      }),
    },
  ]);
});

test("update without a success status is unknown", async () => {
  const { call } = await connect({ onWrite: () => Response.json({}) });
  expect(
    (
      await call("youtube_update_playlist", {
        playlist_id: playlist,
        title: "x",
      })
    ).code,
  ).toBe("WRITE_OUTCOME_UNKNOWN");
});

test("move input is checked before any request", async () => {
  const { call, writes, f } = await connect();
  for (const args of [
    { playlist_id: "LL", video_id: v(1), after_video_id: v(2) },
    { playlist_id: playlist, video_id: v(1), after_video_id: v(1) },
    { playlist_id: playlist, video_id: "short", after_video_id: v(2) },
    { playlist_id: playlist, video_id: v(1) },
  ])
    expect((await call("youtube_move_in_playlist", args)).code).toBe("invalid");
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("move finds both entries across pages and sends one set-ID edit", async () => {
  const { call, writes } = await connect();
  const { result } = await call("youtube_move_in_playlist", {
    playlist_id: playlist,
    video_id: v(1),
    after_video_id: v(4),
  });
  expect(result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: playlist,
    video_id: v(1),
    after_video_id: v(4),
  });
  expect(writes).toEqual([
    {
      path: "/youtubei/v1/browse/edit_playlist",
      body: expect.objectContaining({
        playlistId: playlist,
        actions: [
          {
            action: "ACTION_MOVE_VIDEO_AFTER",
            setVideoId: "set-1",
            movedSetVideoIdPredecessor: "set-4",
          },
        ],
      }),
    },
  ]);
});

test("a video missing from the playlist is refused without an edit", async () => {
  const { call, writes } = await connect();
  expect(
    (
      await call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: v(1),
        after_video_id: v(9),
      })
    ).code,
  ).toBe("PLAYLIST_ITEM_NOT_FOUND");
  expect(writes).toEqual([]);
});

test("a video listed twice is ambiguous and refused without an edit", async () => {
  // Fourteen entries wrap around the thirteen fixture IDs, so v…00 appears twice.
  const { call, writes } = await connect({ pages: [7, 7] });
  expect(
    (
      await call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: v(0),
        after_video_id: v(3),
      })
    ).code,
  ).toBe("PLAYLIST_ITEM_AMBIGUOUS");
  expect(writes).toEqual([]);
});

// Without the end of the list a duplicate further down cannot be ruled out.
test("the entry lookup reads at most 60 pages and refuses an unfinished scan", async () => {
  const { call, writes, browses } = await connect({ pages: Array(70).fill(1) });
  expect(
    (
      await call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: v(1),
        after_video_id: v(2),
      })
    ).code,
  ).toBe("PLAYLIST_TOO_LONG");
  // One identity read plus at most 60 playlist pages.
  expect(browses()).toBeLessThanOrEqual(61);
  expect(writes).toEqual([]);
});
