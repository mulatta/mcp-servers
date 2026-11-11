import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import {
  cdpUrl,
  ids,
  items,
  prefix,
  sampleVideos,
  timeout,
  until,
  mayClean,
  verifyAccount,
  writes,
  type Live,
} from "./live.ts";

/**
 * Real writes whose answers are lost after YouTube processed them: the
 * server must report WRITE_OUTCOME_UNKNOWN, and the change must exist. The
 * server runs in process so a network wrapper can drop or delay the answer.
 */
describe.skipIf(!writes)("live uncertain write outcomes", () => {
  let fault: "none" | "drop" | "slow" = "none";
  let live: Live;
  let close: () => Promise<void>;
  let playlist: string | undefined;
  const title = `${prefix} outcome ${new Date().toISOString()}`;

  beforeAll(async () => {
    const network = async (request: Request) => {
      const isWrite = !new URL(request.url).pathname.endsWith("/browse");
      const response = await fetch(request);
      if (isWrite && fault === "drop") {
        await response.arrayBuffer();
        throw new Error("answer dropped after YouTube processed the write");
      }
      // Longer than the 3 s deadline below, after YouTube has the write.
      if (isWrite && fault === "slow") await Bun.sleep(6000);
      return response;
    };
    const backend = createBackend({ cdpUrl, network });
    const server = createServer(backend.reader, {
      writer: backend.writer,
      writes: new Set(["playlist"]),
      timeoutMs: 3000,
    });
    const client = new Client({ name: "youtube-live-outcome", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: unknown;
      };
    const code = (result: { isError?: boolean; content?: unknown }) =>
      result.isError
        ? (/"code":"(\w+)"/.exec(
            (result.content as { text?: string }[] | undefined)?.[0]?.text ??
              "",
          )?.[1] ?? "UNKNOWN")
        : "OK";
    live = {
      call,
      code,
      async ok(name, args) {
        const result = await call(name, args);
        if (result.isError)
          throw new Error(`${name} failed with ${code(result)}`);
        return result.structuredContent ?? {};
      },
      close: () => client.close(),
    };
    close = async () => {
      await client.close();
      await server.close();
    };
    await verifyAccount(live);
  }, timeout);
  afterAll(async () => {
    fault = "none";
    if (!mayClean(live)) return void (await close?.());
    for (const item of items(
      await live.ok("youtube_list_playlists", { limit: 100 }),
    ))
      if (item.title === title || item.playlist_id === playlist)
        await live.call("youtube_delete_playlist", {
          playlist_id: item.playlist_id,
        });
    await close?.();
  }, timeout);

  const findPlaylist = async () =>
    items(await live.ok("youtube_list_playlists", { limit: 100 })).find(
      (item) => item.title === title,
    )?.playlist_id as string | undefined;

  test(
    "a create whose answer is dropped is unknown, and the playlist exists",
    async () => {
      fault = "drop";
      const result = await live.call("youtube_create_playlist", { title });
      fault = "none";
      expect(live.code(result)).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(
        await until(
          async () => (playlist = await findPlaylist()) !== undefined,
        ),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "an add held past the deadline is unknown, and the video is added",
    async () => {
      expect(playlist !== undefined).toBe(true);
      const [video] = await sampleVideos(live, 1);
      fault = "slow";
      const result = await live.call("youtube_add_to_playlist", {
        playlist_id: playlist,
        video_ids: [video],
      });
      fault = "none";
      expect(live.code(result)).toBe("WRITE_OUTCOME_UNKNOWN");
      expect(
        await until(async () =>
          ids(
            items(
              await live.ok("youtube_get_playlist", {
                playlist_id: playlist,
                limit: 5,
              }),
            ),
          ).includes(video!),
        ),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "a refusal before sending stays a plain error",
    async () => {
      const result = await live.call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: "aaaaaaaaaaa",
        after_video_id: "bbbbbbbbbbb",
      });
      expect(live.code(result)).toBe("PLAYLIST_ITEM_NOT_FOUND");
    },
    timeout,
  );
});
