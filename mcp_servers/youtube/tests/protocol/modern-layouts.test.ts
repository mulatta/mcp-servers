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

const playlistLockup = (
  id: string,
  badge: string,
  contentType = "LOCKUP_CONTENT_TYPE_PLAYLIST",
) => ({
  richItemRenderer: {
    content: {
      lockupViewModel: {
        contentId: id,
        contentType,
        contentImage: {
          collectionThumbnailViewModel: {
            primaryThumbnail: {
              thumbnailViewModel: {
                overlays: [
                  {
                    thumbnailOverlayBadgeViewModel: {
                      thumbnailBadges: [
                        { thumbnailBadgeViewModel: { text: badge } },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
        metadata: {
          lockupMetadataViewModel: { title: { content: "Fixture playlist" } },
        },
      },
    },
  },
});

const playlistGrid = (contents: unknown[]) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: { richGridRenderer: { contents } },
          },
        },
      ],
    },
  },
});

test("lockup playlists read counts from thumbnail badges", () => {
  const result = normalize(
    playlistGrid([
      playlistLockup("PLfixture0000000001", "3,890 videos"),
      playlistLockup("PLfixture0000000002", "1 video"),
      playlistLockup(
        "PLfixture0000000003",
        "7 lessons",
        "LOCKUP_CONTENT_TYPE_COURSE",
      ),
      playlistLockup("RDfixture0000000004", "Mix"),
      playlistLockup("PLfixture0000000005", "1.2K videos"),
    ]),
    "playlists",
  );
  expect(
    result.items.map((item) => "playlist_id" in item && item.playlist_id),
  ).toEqual([
    "PLfixture0000000001",
    "PLfixture0000000002",
    "PLfixture0000000003",
    "RDfixture0000000004",
    "PLfixture0000000005",
  ]);
  expect(
    result.items.map((item) => "video_count" in item && item.video_count),
  ).toEqual([3890, 1, 7, null, null]);
});

test("playlist lockups of unknown content types are rejected", () => {
  expect(() =>
    normalize(
      playlistGrid([
        playlistLockup("PLfixture0000000001", "1 video"),
        playlistLockup(
          "PLfixture0000000002",
          "1 video",
          "LOCKUP_CONTENT_TYPE_VIDEO",
        ),
      ]),
      "playlists",
    ),
  ).toThrow();
});

test("lockup videos read the channel from the first metadata row", () => {
  const result = normalize(
    page([
      {
        lockupViewModel: {
          ...video.lockupViewModel,
          metadata: {
            lockupMetadataViewModel: {
              title: { content: "Fixture video" },
              metadata: {
                contentMetadataViewModel: {
                  metadataRows: [
                    {
                      metadataParts: [{ text: { content: "Fixture channel" } }],
                    },
                    {
                      metadataParts: [
                        { text: { content: "16K views" } },
                        { text: { content: "4 days ago" } },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      video,
    ]),
    "videos",
  );
  expect(
    result.items.map((item) => "channel_name" in item && item.channel_name),
  ).toEqual(["Fixture channel", null]);
});
