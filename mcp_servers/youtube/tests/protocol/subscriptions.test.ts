import { expect, test } from "bun:test";
import channels from "../fixtures/library/channels.json";
import { normalize } from "../../src/youtube/normalize.ts";
import { SafeError } from "../../src/errors.ts";

// FEchannels shapes follow youtubei.js 18.3.0 parsers (Channel, SubscribeButton,
// SubscriptionNotificationToggleButton); all values are synthetic.
const channel = (overrides: Record<string, unknown> = {}) => {
  const copy = structuredClone(channels);
  const shelf =
    copy.contents.twoColumnBrowseResultsRenderer.tabs[0]!.tabRenderer.content
      .sectionListRenderer.contents[0]!.itemSectionRenderer.contents[0]!
      .shelfRenderer.content.expandedShelfContentsRenderer;
  const renderer = { ...shelf.items[0]!.channelRenderer, ...overrides };
  return {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            itemSectionRenderer: { contents: [{ channelRenderer: renderer }] },
          },
        ],
      },
    },
  };
};

test("subscriptions normalize channel identity, handle, size and bell state", () => {
  expect(normalize(channels, "channels").items).toEqual([
    {
      channel_id: "UCfixture000000000000001",
      title: "Fixture",
      handle: "@fixture1",
      subscriber_count_text: "1.2K subscribers",
      notification: "all",
    },
    {
      channel_id: "UCfixture000000000000002",
      title: "Fixture",
      handle: "@fixture2",
      subscriber_count_text: "3 subscribers",
      notification: "none",
    },
  ]);
});

test("the bell state follows the current state's icon, not its numeric ID", () => {
  const [item] = normalize(channel({}), "channels").items;
  expect(item).toMatchObject({ notification: "all" });
  const personalized = channel();
  const renderer = (
    personalized.contents.sectionListRenderer.contents[0]!.itemSectionRenderer
      .contents[0]! as { channelRenderer: { subscribeButton: unknown } }
  ).channelRenderer;
  const toggle = (
    renderer.subscribeButton as {
      subscribeButtonRenderer: {
        notificationPreferenceButton: {
          subscriptionNotificationToggleButtonRenderer: {
            currentStateId: number;
          };
        };
      };
    }
  ).subscribeButtonRenderer.notificationPreferenceButton
    .subscriptionNotificationToggleButtonRenderer;
  toggle.currentStateId = 2;
  expect(normalize(personalized, "channels").items[0]).toMatchObject({
    notification: "personalized",
  });
});

test("fields YouTube swaps or omits stay null instead of being guessed", () => {
  const [item] = normalize(
    channel({
      subscriberCountText: { simpleText: "1.2K subscribers" },
      videoCountText: { simpleText: "42 videos" },
      subscribeButton: undefined,
    }),
    "channels",
  ).items;
  expect(item).toMatchObject({
    handle: null,
    subscriber_count_text: null,
    notification: null,
  });
});

test("an invalid channel ID is not reported", () => {
  const [item] = normalize(
    channel({ channelId: "not-a-channel" }),
    "channels",
  ).items;
  expect(item).toMatchObject({ channel_id: null });
});

test("unknown entries in the subscriptions list fail closed", () => {
  expect(() =>
    normalize(
      {
        contents: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [{ videoRenderer: { videoId: "v0000000001" } }],
                },
              },
            ],
          },
        },
      },
      "channels",
    ),
  ).toThrow(SafeError);
});
