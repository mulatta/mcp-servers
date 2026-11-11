import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect as tcp } from "node:net";
import {
  connectHttp,
  ids,
  items,
  prefix,
  publicChannels,
  reads,
  sampleVideos,
  timeout,
  until,
  writes,
  type HttpLive,
  verifyAccount,
} from "./live.ts";

// The deployment talks to the server over HTTP, so the transport itself is
// checked against the real account, not only stdio.
describe.skipIf(!reads)("live over HTTP", () => {
  let live: HttpLive;
  beforeAll(async () => {
    live = await connectHttp();
    await verifyAccount(live);
  }, timeout);
  afterAll(() => live?.close());

  test(
    "initialize returns instructions and tools/list every enabled tool",
    async () => {
      const init = (await (
        await live.rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "youtube-live-test", version: "1" },
        })
      ).json()) as { result?: { instructions?: string } };
      expect((init.result?.instructions ?? "").length > 100).toBe(true);
      const list = (await (await live.rpc("tools/list", {})).json()) as {
        result?: { tools?: unknown[] };
      };
      expect(list.result?.tools?.length).toBe(writes ? 20 : 9);
    },
    timeout,
  );

  test(
    "a read over HTTP returns the account's items",
    async () => {
      // A public channel has uploads whatever the account holds.
      const result = await live.ok("youtube_get_channel_videos", {
        channel_id: publicChannels[0],
        limit: 5,
      });
      expect(/^UC[\w-]{22}$/.test(result.account_id as string)).toBe(true);
      expect(items(result).length > 0).toBe(true);
    },
    timeout,
  );

  test(
    "requests without the token are refused",
    async () => {
      const response = await live.rpc("tools/list", {}, "");
      expect(response.status).toBe(401);
    },
    timeout,
  );

  // Hermes leaked half-closed keep-alive sockets through its relay; every
  // answer must end its connection.
  test(
    "every answer carries Connection: close and closes the socket",
    async () => {
      const closed = await new Promise<{ header: boolean; ms: number }>(
        (resolve, reject) => {
          const socket = tcp(Number(live.url.port), live.url.hostname);
          const started = performance.now();
          let data = "";
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("connection stayed open"));
          }, 5000);
          socket.on("data", (chunk) => (data += chunk));
          socket.on("end", () => {
            clearTimeout(timer);
            socket.destroy();
            resolve({
              header: /\r\nconnection: close\r\n/i.test(data),
              ms: performance.now() - started,
            });
          });
          socket.on("error", reject);
          const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          });
          socket.write(
            [
              "POST /mcp HTTP/1.1",
              `Host: 127.0.0.1:${live.url.port}`,
              "Connection: keep-alive",
              `Authorization: Bearer ${live.token}`,
              "Content-Type: application/json",
              "Accept: application/json, text/event-stream",
              "MCP-Protocol-Version: 2025-06-18",
              `Content-Length: ${Buffer.byteLength(body)}`,
              "",
              body,
            ].join("\r\n"),
          );
        },
      );
      expect(closed.header).toBe(true);
      expect(closed.ms < 3000).toBe(true);
    },
    timeout,
  );

  test.skipIf(!writes)(
    "a playlist write cycle works over HTTP",
    async () => {
      const [video] = await sampleVideos(live, 1);
      const created = await live.ok("youtube_create_playlist", {
        title: `${prefix} http ${new Date().toISOString()}`,
      });
      const playlist = created.playlist_id as string;
      try {
        await live.ok("youtube_add_to_playlist", {
          playlist_id: playlist,
          video_ids: [video],
        });
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
      } finally {
        await live.call("youtube_delete_playlist", { playlist_id: playlist });
      }
    },
    timeout,
  );
});
