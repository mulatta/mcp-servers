import { expect, test } from "bun:test";
import { normalize } from "../../src/youtube/normalize.ts";

// Structural variants observed in an approved live check. All values are synthetic.
const video = {
  lockupViewModel: {
    contentId: "v0000000001",
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    metadata: {
      lockupMetadataViewModel: { title: { content: "Fixture video" } },
    },
  },
};
const page = (items: unknown[]) => ({
  contents: {
    sectionListRenderer: {
      contents: [
        {
          itemSectionRenderer: {
            header: {
              itemSectionHeaderRenderer: { title: { simpleText: "Today" } },
            },
            contents: items,
          },
        },
      ],
    },
  },
});
const continuation = {
  continuationCommand: {
    token: "fixture-next",
    request: "CONTINUATION_REQUEST_TYPE_BROWSE",
  },
};

test("modern playlist and liked-video continuations retain buffered videos", () => {
  const result = normalize(
    page([
      video,
      {
        continuationItemViewModel: {
          continuationCommand: { innertubeCommand: continuation },
        },
      },
    ]),
    "videos",
  );
  expect(result.items).toHaveLength(1);
  expect(result.continuation).toBe("fixture-next");
});

test("watch-later command bundles extract continuation without executing commands", () => {
  const result = normalize(
    {
      contents: {
        playlistVideoListRenderer: {
          contents: [
            video,
            {
              continuationItemRenderer: {
                continuationEndpoint: {
                  commandExecutorCommand: {
                    commands: [
                      {
                        playlistVotingRefreshPopupCommand: {
                          command: { notificationActionRenderer: {} },
                        },
                      },
                      continuation,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
    "videos",
  );
  expect(result.items).toHaveLength(1);
  expect(result.continuation).toBe("fixture-next");
});

test("history preserves shorts, duplicates, date groups and mixed video order", () => {
  const short = {
    shortsLockupViewModel: {
      onTap: {
        innertubeCommand: { reelWatchEndpoint: { videoId: "s0000000001" } },
      },
      overlayMetadata: {
        primaryText: { content: "Fixture short" },
        secondaryText: { content: "Not a channel name" },
      },
    },
  };
  const result = normalize(
    page([
      {
        reelShelfRenderer: {
          title: { simpleText: "Shorts" },
          items: [short, short],
        },
      },
      video,
    ]),
    "history",
  );
  expect(
    result.items.map((item) => ("video_id" in item ? item.video_id : null)),
  ).toEqual(["s0000000001", "s0000000001", "v0000000001"]);
  expect(result.items[0]).toMatchObject({
    title: "Fixture short",
    channel_name: null,
    watched_at: null,
    group_label: "Today",
  });
  expect(result.items[0]).toEqual(result.items[1]);
});

test("ambiguous continuation bundles and unknown shelf entries still fail closed", () => {
  expect(() =>
    normalize(
      page([
        {
          continuationItemViewModel: {
            continuationCommand: {
              commandExecutorCommand: {
                commands: [
                  continuation,
                  { continuationCommand: { token: "different" } },
                ],
              },
            },
          },
        },
      ]),
      "videos",
    ),
  ).toThrow();
  expect(() =>
    normalize(
      page([{ reelShelfRenderer: { items: [{ unknownVideoRenderer: {} }] } }]),
      "history",
    ),
  ).toThrow();
});
