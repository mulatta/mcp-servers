import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  all,
  cdpUrl,
  connect,
  ids,
  items,
  mayClean,
  outsider,
  prefix,
  publicChannels,
  sameOrder,
  sampleVideos,
  timeout,
  until,
  verifyAccount,
  writes,
  type Live,
} from "./live.ts";
import { watch } from "./watch.ts";

/**
 * The whole account, end to end: clear it, read every list empty, write
 * through every write tool, read the writes back, change them, and clear it
 * again. It runs only against the pinned test account, whose state it
 * discards; a failed account check stops it before the first write and
 * skips the final clear.
 */
describe.skipIf(!writes)("live end to end", () => {
  let live: Live;
  let videos: string[];
  let playlist = "";

  const list = async (name: string, args: Record<string, unknown> = {}) =>
    (await all(live, name, args)).items;
  const watchLater = async () => ids(await list("youtube_get_watch_later"));
  const liked = async () => ids(await list("youtube_get_liked_videos"));
  const subscriptions = async () =>
    ids(await list("youtube_list_subscriptions"), "channel_id");
  // The library also lists Watch Later and liked videos once they hold
  // anything; only the account's own PL playlists can be deleted.
  const playlists = async () =>
    ids(await list("youtube_list_playlists"), "playlist_id").filter((id) =>
      id.startsWith("PL"),
    );

  const empty = async () => {
    const [a, b, c, d] = await Promise.all([
      playlists(),
      watchLater(),
      liked(),
      subscriptions(),
    ]);
    return !a.length && !b.length && !c.length && !d.length;
  };

  /**
   * Removes everything the write tools can remove, waits until the reads
   * agree, and checks again later: removals once seemed applied, then the
   * entries came back.
   */
  async function clear() {
    for (const id of await playlists())
      await live.ok("youtube_delete_playlist", { playlist_id: id });
    const later = await watchLater();
    for (let i = 0; i < later.length; i += 50)
      await live.ok("youtube_remove_from_playlist", {
        playlist_id: "WL",
        video_ids: [...new Set(later.slice(i, i + 50))],
      });
    for (const video of await liked())
      await live.ok("youtube_remove_rating", { video_id: video });
    for (const channel of await subscriptions())
      await live.ok("youtube_unsubscribe", { channel_id: channel });
    if (!(await until(empty, 90))) return false;
    await Bun.sleep(20_000);
    return empty();
  }

  beforeAll(async () => {
    live = await connect();
    await verifyAccount(live);
    // Over 100, so Watch Later needs a second page.
    videos = await sampleVideos(live, 105);
  }, timeout);
  afterAll(async () => {
    if (mayClean(live)) await clear().catch(() => {});
    await live?.close();
  }, timeout * 2);

  test(
    "clearing leaves every list empty",
    async () => {
      expect(await clear()).toBe(true);
      expect((await playlists()).length).toBe(0);
      for (const name of [
        "youtube_list_subscriptions",
        "youtube_get_watch_later",
        "youtube_get_liked_videos",
        "youtube_get_subscription_feed",
      ]) {
        const result = await live.ok(name, { limit: 5 });
        expect({ name, empty: items(result).length === 0 }).toEqual({
          name,
          empty: true,
        });
        expect({ name, end: result.next_cursor ?? null }).toEqual({
          name,
          end: null,
        });
      }
    },
    timeout * 2,
  );

  test(
    "subscribe follows each channel once, even when repeated",
    async () => {
      const followed = async () =>
        sameOrder(
          [...(await subscriptions())].sort(),
          [...publicChannels].sort(),
        );
      for (const channel of publicChannels)
        expect(
          (await live.ok("youtube_subscribe", { channel_id: channel }))
            .subscribed,
        ).toBe(true);
      expect(await until(followed)).toBe(true);
      // Repeated once the list shows it. Repeating within a second of the
      // first call has come back unconfirmed (WRITE_OUTCOME_UNKNOWN).
      expect(
        (
          await live.ok("youtube_subscribe", {
            channel_id: publicChannels[0],
          })
        ).subscribed,
      ).toBe(true);
      expect(await followed()).toBe(true);
    },
    timeout,
  );

  test(
    "the subscription feed lists only followed channels, without repeats",
    async () => {
      let feed: Record<string, unknown>[] = [];
      expect(
        await until(async () => {
          feed = (await all(live, "youtube_get_subscription_feed", {}, 2))
            .items;
          return feed.length > 0;
        }, 90),
      ).toBe(true);
      const videos = ids(feed);
      expect(new Set(videos).size).toBe(videos.length);
      // Collaborations name no single channel.
      const named = feed
        .map((item) => item.channel_id as string | null)
        .filter((id): id is string => !!id);
      expect(named.length > 0).toBe(true);
      expect(named.every((id) => publicChannels.includes(id))).toBe(true);
    },
    timeout,
  );

  test(
    "bells cycle through every setting; an unfollowed channel is refused",
    async () => {
      const channel = publicChannels[0]!;
      const bell = async () =>
        (await list("youtube_list_subscriptions")).find(
          (item) => item.channel_id === channel,
        )?.notification;
      for (const setting of ["all", "none", "personalized"]) {
        expect(
          (
            await live.ok("youtube_set_channel_notifications", {
              channel_id: channel,
              setting,
            })
          ).notification,
        ).toBe(setting);
        expect(await until(async () => (await bell()) === setting)).toBe(true);
      }
      const refused = await live.call("youtube_set_channel_notifications", {
        channel_id: outsider,
        setting: "none",
      });
      expect(live.code(refused)).toBe("CHANNEL_NOT_SUBSCRIBED");
    },
    timeout,
  );

  test(
    "likes list each liked video once, with durations and channels",
    async () => {
      const [first, second] = videos as [string, string];
      for (const video of [first, first, second])
        expect(
          (await live.ok("youtube_like_video", { video_id: video })).rating,
        ).toBe("like");
      expect(
        await until(async () =>
          sameOrder([...(await liked())].sort(), [first, second].sort()),
        ),
      ).toBe(true);
      const page = items(await live.ok("youtube_get_liked_videos"));
      expect(
        page.every((item) => typeof item.duration_seconds === "number"),
      ).toBe(true);
      expect(page.every((item) => item.channel_name)).toBe(true);
      for (let i = 0; i < 2; i++)
        expect(
          (await live.ok("youtube_remove_rating", { video_id: second })).rating,
        ).toBe("none");
      expect(await until(async () => sameOrder(await liked(), [first]))).toBe(
        true,
      );
    },
    timeout,
  );

  // Watch Later puts each added batch on top, in the batch's own order.
  let later: string[] = [];

  test(
    "Watch Later takes batches, pages to its end and keeps their order",
    async () => {
      for (let i = 0; i < videos.length; i += 50) {
        const batch = videos.slice(i, i + 50);
        await live.ok("youtube_add_to_playlist", {
          playlist_id: "WL",
          video_ids: batch,
        });
        later = [...batch, ...later];
      }
      let read = await all(live, "youtube_get_watch_later");
      expect(
        await until(async () => {
          read = await all(live, "youtube_get_watch_later");
          return read.items.length === videos.length;
        }, 90),
      ).toBe(true);
      expect(read.complete).toBe(true);
      expect(sameOrder(ids(read.items), later)).toBe(true);
    },
    timeout * 2,
  );

  test(
    "Watch Later moves an entry to the top and back, then removes some",
    async () => {
      const [first, previous, moved] = [later[0]!, later[4]!, later[5]!];
      await live.ok("youtube_move_in_playlist", {
        playlist_id: "WL",
        video_id: moved,
        before_video_id: first,
      });
      expect(
        await until(async () => (await watchLater())[0] === moved, 60),
      ).toBe(true);
      await live.ok("youtube_move_in_playlist", {
        playlist_id: "WL",
        video_id: moved,
        after_video_id: previous,
      });
      expect(
        await until(async () => sameOrder(await watchLater(), later), 60),
      ).toBe(true);
      await live.ok("youtube_remove_from_playlist", {
        playlist_id: "WL",
        video_ids: later.slice(0, 2),
      });
      expect(
        await until(
          async () => sameOrder(await watchLater(), later.slice(2)),
          60,
        ),
      ).toBe(true);
    },
    timeout * 2,
  );

  test(
    "a playlist is created private and reads back empty",
    async () => {
      const created = await live.ok("youtube_create_playlist", {
        title: `${prefix} ${new Date().toISOString()}`,
      });
      playlist = created.playlist_id as string;
      expect(/^PL[\w-]{10,64}$/.test(playlist)).toBe(true);
      // A new playlist reads as unavailable for a few seconds.
      expect(
        await until(
          async () =>
            (
              await live.ok("youtube_get_playlist_details", {
                playlist_id: playlist,
              })
            ).privacy === "private",
        ),
      ).toBe(true);
      expect(
        items(await live.ok("youtube_get_playlist", { playlist_id: playlist }))
          .length,
      ).toBe(0);
      expect(
        await until(async () => (await playlists()).includes(playlist)),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "a playlist's title, description and privacy change and read back",
    async () => {
      const details = () =>
        live.ok("youtube_get_playlist_details", { playlist_id: playlist });
      const title = `${prefix} renamed ${Date.now()}`;
      await live.ok("youtube_update_playlist", {
        playlist_id: playlist,
        title,
        description: "live test",
        privacy: "UNLISTED",
      });
      expect(
        await until(async () => {
          const now = await details();
          return (
            now.title === title &&
            now.description === "live test" &&
            now.privacy === "unlisted"
          );
        }),
      ).toBe(true);
      await live.ok("youtube_update_playlist", {
        playlist_id: playlist,
        privacy: "PRIVATE",
      });
      expect(
        await until(async () => (await details()).privacy === "private"),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "a playlist's videos are added, moved, refused and removed",
    async () => {
      const [a, b, c] = videos as [string, string, string];
      const order = async () =>
        ids(await list("youtube_get_playlist", { playlist_id: playlist }));
      await live.ok("youtube_add_to_playlist", {
        playlist_id: playlist,
        video_ids: [a, b, c],
      });
      expect(await until(async () => sameOrder(await order(), [a, b, c]))).toBe(
        true,
      );
      await live.ok("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: a,
        after_video_id: c,
      });
      expect(await until(async () => sameOrder(await order(), [b, c, a]))).toBe(
        true,
      );
      await live.ok("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: a,
        before_video_id: b,
      });
      expect(await until(async () => sameOrder(await order(), [a, b, c]))).toBe(
        true,
      );
      const missing = await live.call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: a,
        after_video_id: "aaaaaaaaaaa",
      });
      expect(live.code(missing)).toBe("PLAYLIST_ITEM_NOT_FOUND");
      await live.ok("youtube_add_to_playlist", {
        playlist_id: playlist,
        video_ids: [a],
      });
      expect(
        await until(
          async () => (await order()).filter((id) => id === a).length === 2,
        ),
      ).toBe(true);
      const repeated = await live.call("youtube_move_in_playlist", {
        playlist_id: playlist,
        video_id: a,
        after_video_id: c,
      });
      expect(live.code(repeated)).toBe("PLAYLIST_ITEM_AMBIGUOUS");
      await live.ok("youtube_remove_from_playlist", {
        playlist_id: playlist,
        video_ids: [a],
      });
      expect(await until(async () => sameOrder(await order(), [b, c]))).toBe(
        true,
      );
    },
    timeout * 2,
  );

  test(
    "Watch Later and liked videos have details",
    async () => {
      for (const id of ["WL", "LL"]) {
        const details = await live.ok("youtube_get_playlist_details", {
          playlist_id: id,
        });
        expect(typeof details.title).toBe("string");
      }
    },
    timeout,
  );

  test(
    "a deleted playlist becomes unavailable",
    async () => {
      await live.ok("youtube_delete_playlist", { playlist_id: playlist });
      expect(
        await until(
          async () =>
            live.code(
              await live.call("youtube_get_playlist_details", {
                playlist_id: playlist,
              }),
            ) === "PLAYLIST_UNAVAILABLE",
        ),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "a played video appears at the top of the watch history",
    async () => {
      // No tool writes or clears history; the browser plays a video instead.
      const video = videos[videos.length - 1]!;
      await watch(cdpUrl, video);
      expect(
        await until(
          async () =>
            ids(
              items(await live.ok("youtube_get_watch_history", { limit: 5 })),
            )[0] === video,
          90,
        ),
      ).toBe(true);
    },
    timeout,
  );

  test(
    "clearing after the writes leaves every list empty again",
    async () => {
      expect(await clear()).toBe(true);
    },
    timeout * 2,
  );
});
