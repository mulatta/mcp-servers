import { expect, test } from "bun:test";
import feed from "../fixtures/library/subscription-feed.json";
import { normalize } from "../../src/youtube/normalize.ts";

// Layout from a key-only live probe of FEsubscriptions; all values are synthetic.
test("the feed reads only its chronological items, skipping the shelves", () => {
  const page = normalize(feed, "subscription_feed");
  expect(page.items).toEqual([
    {
      video_id: "v0000000021",
      title: "Fixture",
      url: "https://www.youtube.com/watch?v=v0000000021",
      channel_name: "Fixture channel",
      channel_id: "UCfixture000000000000001",
      availability: "available",
      watched_percent: 40,
      duration_seconds: 754,
      published_text: "3 hours ago",
      is_upcoming: false,
    },
    {
      video_id: "v0000000022",
      title: "Fixture",
      url: "https://www.youtube.com/watch?v=v0000000022",
      // A collaboration opens a dialog instead of naming one channel.
      channel_name: "Fixture channel and Fixture",
      channel_id: null,
      availability: "available",
      watched_percent: null,
      duration_seconds: null,
      published_text: null,
      is_upcoming: true,
    },
  ]);
  expect(page.continuation).toBe("fixture-next");
});

const appended = (items: unknown[], extra: unknown[] = []) => ({
  onResponseReceivedActions: [
    { resetSubscriptionsUnreadDotCommand: { targetId: "fixture" } },
    ...extra,
    { appendContinuationItemsAction: { continuationItems: items } },
  ],
});
const item = feed.contents.twoColumnBrowseResultsRenderer.tabs[0]!.tabRenderer
  .content.richGridRenderer.contents[1] as unknown;

test("feed continuations ignore the unread-dot reset and read appended items", () => {
  const page = normalize(appended([item]), "subscription_feed", {
    continuation: true,
  });
  expect(page.items.map((x) => "video_id" in x && x.video_id)).toEqual([
    "v0000000021",
  ]);
});

test("any other action without items stays unsupported", () => {
  expect(() =>
    normalize(
      appended([item], [{ fixtureUnknownCommand: {} }]),
      "subscription_feed",
      { continuation: true },
    ),
  ).toThrow();
});

test("shelves and the unread-dot reset are accepted only in the subscription feed", () => {
  expect(() => normalize(feed, "videos")).toThrow();
  expect(() =>
    normalize(appended([item]), "videos", { continuation: true }),
  ).toThrow();
});

// Observed live: the reset action also carries clickTrackingParams.
test("the unread-dot reset is ignored with its tracking params", () => {
  const response = {
    onResponseReceivedActions: [
      {
        clickTrackingParams: "fixture",
        resetSubscriptionsUnreadDotCommand: { targetId: "fixture" },
      },
      {
        clickTrackingParams: "fixture",
        appendContinuationItemsAction: { continuationItems: [item] },
      },
    ],
  };
  expect(
    normalize(response, "subscription_feed", { continuation: true }).items,
  ).toHaveLength(1);
});

test("tracking params alone do not make an unknown action acceptable", () => {
  const response = {
    onResponseReceivedActions: [
      { clickTrackingParams: "fixture" },
      { appendContinuationItemsAction: { continuationItems: [item] } },
    ],
  };
  expect(() =>
    normalize(response, "subscription_feed", { continuation: true }),
  ).toThrow();
});

// Observed live on an account that follows no channel (2026-11-11): the feed
// suggests channels to follow instead of listing videos.
const suggestions = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            selected: true,
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [
                        {
                          shelfRenderer: {
                            content: {
                              gridRenderer: {
                                items: [
                                  {
                                    gridChannelRenderer: {
                                      channelId: "UCfixture000000000000001",
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

test("channel suggestions on an empty feed are not feed items", () => {
  expect(normalize(suggestions, "subscription_feed")).toEqual({
    items: [],
    continuation: null,
  });
});

test("channel suggestions elsewhere stay a layout change", () => {
  expect(() => normalize(suggestions, "videos")).toThrow();
});
