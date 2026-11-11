import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  connect,
  items,
  publicChannels,
  reads,
  timeout,
  verifyAccount,
  type Live,
} from "./live.ts";

describe.skipIf(!reads)("live reads", () => {
  let live: Live;
  let account: string;
  beforeAll(async () => {
    live = await connect();
    await verifyAccount(live);
  }, timeout);
  afterAll(() => live?.close());

  test(
    "every list tool returns at most five items for one account",
    async () => {
      const playlists = await live.ok("youtube_list_playlists", { limit: 5 });
      account = playlists.account_id as string;
      const playlist =
        items(playlists).find((item) => item.playlist_id)?.playlist_id ?? "WL";
      const subscriptions = await live.ok("youtube_list_subscriptions", {
        limit: 5,
      });
      const channel = items(subscriptions)[0]?.channel_id ?? account;
      for (const [name, args] of [
        ["youtube_get_playlist", { playlist_id: playlist }],
        ["youtube_get_watch_later", {}],
        ["youtube_get_liked_videos", {}],
        ["youtube_get_watch_history", {}],
        ["youtube_get_channel_videos", { channel_id: channel }],
        ["youtube_get_subscription_feed", {}],
      ] as const) {
        const result = await live.ok(name, { ...args, limit: 5 });
        expect({ name, sameAccount: result.account_id === account }).toEqual({
          name,
          sameAccount: true,
        });
        expect({ name, withinLimit: items(result).length <= 5 }).toEqual({
          name,
          withinLimit: true,
        });
      }
    },
    timeout,
  );

  test(
    "a public channel's uploads carry durations and publish labels",
    async () => {
      const uploads = items(
        await live.ok("youtube_get_channel_videos", {
          channel_id: publicChannels[0],
          limit: 20,
        }),
      );
      expect(uploads.length > 0).toBe(true);
      expect(
        uploads.filter((item) => typeof item.duration_seconds === "number")
          .length > 0,
      ).toBe(true);
      expect(uploads.filter((item) => item.published_text).length > 0).toBe(
        true,
      );
    },
    timeout,
  );

  test(
    "playlist details read the title of a listed playlist",
    async () => {
      const details = await live.ok("youtube_get_playlist_details", {
        playlist_id: "WL",
      });
      expect(details.account_id === account).toBe(true);
      expect(typeof details.title === "string").toBe(true);
    },
    timeout,
  );

  test(
    "a made-up channel ID is reported as unavailable",
    async () => {
      const result = await live.call("youtube_get_channel_videos", {
        channel_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(live.code(result)).toBe("CHANNEL_UNAVAILABLE");
    },
    timeout,
  );
});
