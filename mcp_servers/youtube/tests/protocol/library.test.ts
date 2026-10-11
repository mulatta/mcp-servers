import { expect, test } from "bun:test";
import playlist from "../fixtures/library/playlist.json";
import playlists from "../fixtures/library/playlists.json";
import history from "../fixtures/library/history.json";
import { normalize, resultEnvelope } from "../../src/youtube/normalize.ts";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { accountPage } from "../fixtures/account.ts";
import { toolNames } from "../../src/server.ts";

test("five library reads select fixed endpoints and emit account-bound envelopes", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      seen.push(body.browseId);
      return Response.json(
        body.browseId === "SPaccount_advanced"
          ? accountPage("UCaaaaaaaaaaaaaaaaaaaaaa")
          : body.browseId === "FEplaylist_aggregation"
            ? playlists
            : body.browseId === "FEhistory"
              ? history
              : playlist,
      );
    },
  });
  const signal = new AbortController().signal;
  try {
    const session = await YoutubeClient.connect(
      "SAPISID=fixture",
      signal,
      (req) => fetch(new Request(`http://127.0.0.1:${server.port}/`, req)),
    );
    for (const name of toolNames) {
      const page = await session.value.page(
        name,
        { limit: 50, playlist_id: "PLfixture" },
        signal,
      );
      const result = resultEnvelope(session.accountId, page.items, null);
      expect(result.account_id).toBe(session.accountId);
      expect(result.has_more).toBe(false);
      expect(result.items.length).toBeGreaterThan(0);
    }
    expect(seen).toEqual([
      "SPaccount_advanced",
      "FEplaylist_aggregation",
      "VLPLfixture",
      "VLWL",
      "VLLL",
      "FEhistory",
    ]);
  } finally {
    server.stop(true);
  }
});

const list = (contents: unknown[]) => ({
  contents: { playlistVideoListRenderer: { contents } },
});
const video = (title = "Fixture", playable = true) => ({
  playlistVideoRenderer: {
    videoId: "v0000000001",
    title: { simpleText: title },
    isPlayable: playable,
  },
});

test("captured structural fixtures normalize playlist and video summaries", () => {
  expect(normalize(playlist, "videos").items).toHaveLength(2);
  expect(normalize(playlists, "playlists").items).toEqual([
    { playlist_id: "PLfixture0000000016", title: "Fixture", video_count: null },
    { playlist_id: "PLfixture0000000017", title: "Fixture", video_count: null },
  ]);
  const records = normalize(history, "history");
  expect(records.items).toHaveLength(5);
  for (const item of records.items)
    expect(item).toMatchObject({ watched_at: null, group_label: "Fixture" });
  expect(records.continuation).toBe("fixture-next");
});

test("empty, repeated and explicitly unavailable videos retain order", () => {
  expect(normalize(list([]), "videos")).toEqual({
    items: [],
    continuation: null,
  });
  const records = normalize(
    list([
      video(),
      video(),
      video("[Private video]", false),
      video("[Deleted video]", false),
      video("Unknown", false),
    ]),
    "videos",
  ).items;
  expect(records).toHaveLength(5);
  expect(records[0]).toEqual(records[1]);
  expect(records[2]).toMatchObject({
    availability: "private",
    channel_name: null,
  });
  expect(records[3]).toMatchObject({ availability: "deleted" });
  expect(records[4]).toMatchObject({ availability: "unavailable" });
});

test("unknown response or list renderer is not a successful empty result", () => {
  for (const data of [
    {},
    { contents: { unknownRenderer: {} } },
    list([{ newVideoRenderer: {} }]),
  ]) {
    expect(() => normalize(data, "videos")).toThrow();
  }
});
