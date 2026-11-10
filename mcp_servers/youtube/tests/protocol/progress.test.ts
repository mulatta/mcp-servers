import { expect, test } from "bun:test";
import { normalize } from "../../src/youtube/normalize.ts";

// Overlay shapes follow youtubei.js 18.3.0 parsers
// (ThumbnailOverlayResumePlayback, ThumbnailOverlayProgressBarView); values are synthetic.
const rendererVideo = (overlays?: unknown[]) => ({
  playlistVideoRenderer: {
    videoId: "v0000000001",
    title: { simpleText: "Fixture" },
    isPlayable: true,
    ...(overlays ? { thumbnailOverlays: overlays } : {}),
  },
});
const lockupVideo = (overlays?: unknown[]) => ({
  lockupViewModel: {
    contentId: "v0000000002",
    contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
    contentImage: { thumbnailViewModel: { overlays: overlays ?? [] } },
    metadata: { lockupMetadataViewModel: { title: { content: "Fixture" } } },
  },
});
const resume = (percent: unknown) => ({
  thumbnailOverlayResumePlaybackRenderer: { percentDurationWatched: percent },
});
const bar = (percent: unknown) => ({
  thumbnailBottomOverlayViewModel: {
    progressBar: {
      thumbnailOverlayProgressBarViewModel: { startPercent: percent },
    },
  },
});
const watched = (items: unknown[]) =>
  normalize(
    { contents: { playlistVideoListRenderer: { contents: items } } },
    "videos",
  ).items.map((item) =>
    "watched_percent" in item ? item.watched_percent : undefined,
  );

test("video summaries report the resume overlay as watched_percent", () => {
  expect(
    watched([rendererVideo([resume(37)]), lockupVideo([bar(100)])]),
  ).toEqual([37, 100]);
});

test("videos without a progress overlay report null, not zero", () => {
  expect(watched([rendererVideo(), lockupVideo()])).toEqual([null, null]);
});

test("out-of-range or non-integer progress is not reported", () => {
  expect(
    watched([
      rendererVideo([resume(101)]),
      rendererVideo([resume("50")]),
      lockupVideo([bar(-1)]),
      lockupVideo([bar(2.5)]),
    ]),
  ).toEqual([null, null, null, null]);
});

test("history entries carry watched_percent beside their group label", () => {
  const [item] = normalize(
    {
      contents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: { contents: [rendererVideo([resume(12)])] },
            },
          ],
        },
      },
    },
    "history",
  ).items;
  expect(item).toMatchObject({ watched_percent: 12, watched_at: null });
});
