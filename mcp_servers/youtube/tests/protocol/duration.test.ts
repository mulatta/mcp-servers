import { expect, test } from "bun:test";
import { normalize } from "../../src/youtube/normalize.ts";

// Shapes follow youtubei.js 18.3.0 parsers (PlaylistVideo, Video,
// ThumbnailOverlayTimeStatus, ThumbnailBadgeView); all values are synthetic.
const renderer = (fields: Record<string, unknown>) => ({
  playlistVideoRenderer: {
    videoId: "v0000000001",
    title: { simpleText: "Fixture" },
    isPlayable: true,
    ...fields,
  },
});
const video = (fields: Record<string, unknown>) => ({
  videoRenderer: {
    videoId: "v0000000002",
    title: { simpleText: "Fixture" },
    ...fields,
  },
});
const badge = (text: unknown) => ({ thumbnailBadgeViewModel: { text } });
const lockup = (overlays: unknown[]) => ({
  lockupViewModel: {
    contentId: "v0000000003",
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    contentImage: { thumbnailViewModel: { overlays } },
    metadata: { lockupMetadataViewModel: { title: { content: "Fixture" } } },
  },
});
const durations = (items: unknown[]) =>
  normalize(
    { contents: { playlistVideoListRenderer: { contents: items } } },
    "videos",
  ).items.map((item) =>
    "duration_seconds" in item ? item.duration_seconds : undefined,
  );

test("durations come from lengthSeconds, length text and lockup badges", () => {
  expect(
    durations([
      renderer({ lengthSeconds: "754" }),
      video({ lengthText: { simpleText: "1:02:03" } }),
      video({
        thumbnailOverlays: [
          {
            thumbnailOverlayTimeStatusRenderer: {
              text: { simpleText: "4:05" },
            },
          },
        ],
      }),
      lockup([
        {
          thumbnailOverlayBadgeViewModel: { thumbnailBadges: [badge("12:34")] },
        },
      ]),
      lockup([
        { thumbnailBottomOverlayViewModel: { badges: [badge("0:59")] } },
      ]),
    ]),
  ).toEqual([754, 3723, 245, 754, 59]);
});

// Fail closed: anything that is not an exact clock or digit string is unknown.
test("labels that are not exact durations report null", () => {
  expect(
    durations([
      renderer({}),
      renderer({ lengthSeconds: "12a" }),
      renderer({ lengthSeconds: 754 }),
      video({ lengthText: { simpleText: "LIVE" } }),
      video({ lengthText: { simpleText: "1:2" } }),
      video({ lengthText: { simpleText: "12:60" } }),
      video({ lengthText: { simpleText: "1:60:00" } }),
      video({ lengthText: { simpleText: "1:02:03:04" } }),
      lockup([
        { thumbnailOverlayBadgeViewModel: { thumbnailBadges: [badge("Mix")] } },
      ]),
      lockup([{ thumbnailBottomOverlayViewModel: { badges: [badge(42)] } }]),
      lockup([]),
    ]),
  ).toEqual(Array(11).fill(null));
});

test("two lockup badges with different durations are ambiguous", () => {
  expect(
    durations([
      lockup([
        {
          thumbnailOverlayBadgeViewModel: { thumbnailBadges: [badge("1:00")] },
        },
        { thumbnailBottomOverlayViewModel: { badges: [badge("2:00")] } },
      ]),
    ]),
  ).toEqual([null]);
});

test("Shorts carry no duration", () => {
  const [item] = normalize(
    {
      contents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  {
                    shortsLockupViewModel: {
                      onTap: {
                        innertubeCommand: {
                          reelWatchEndpoint: { videoId: "v0000000004" },
                        },
                      },
                      overlayMetadata: { primaryText: { content: "Fixture" } },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    },
    "history",
  ).items;
  expect(item).toMatchObject({ duration_seconds: null });
});
