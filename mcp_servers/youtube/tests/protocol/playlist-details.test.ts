import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import { playlistDetails } from "../../src/youtube/normalize.ts";
import { accountPage } from "../fixtures/account.ts";
import { cdpFixture, cookie } from "../fixtures/cdp.ts";

const playlist = "PLfixture0001";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Key paths observed live on new playlists; values are synthetic.
function page(
  options: {
    privacy?: string[];
    description?: string;
    metadata?: boolean;
    header?: boolean;
  } = {},
) {
  const parts = [
    "Playlist",
    ...(options.privacy ?? ["Private"]),
    "No videos",
    "No views",
  ];
  return {
    ...(options.header === false
      ? {}
      : {
          header: {
            pageHeaderRenderer: {
              content: {
                pageHeaderViewModel: {
                  metadata: {
                    contentMetadataViewModel: {
                      metadataRows: [
                        {
                          metadataParts: [
                            {
                              avatarStack: {
                                avatarStackViewModel: {
                                  text: { content: "by Fixture" },
                                },
                              },
                            },
                          ],
                        },
                        {
                          metadataParts: parts.map((content) => ({
                            text: { content },
                          })),
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
        }),
    ...(options.metadata === false
      ? {}
      : {
          metadata: {
            playlistMetadataRenderer: {
              title: "Fixture title",
              ...(options.description === undefined
                ? {}
                : { description: options.description }),
            },
          },
        }),
  };
}

test("details read title, description and privacy from the playlist page", () => {
  expect(
    playlistDetails(
      page({ privacy: ["Unlisted"], description: "Fixture description" }),
    ),
  ).toEqual({
    title: "Fixture title",
    description: "Fixture description",
    privacy: "unlisted",
  });
  expect(playlistDetails(page({ privacy: ["Public"] }))).toMatchObject({
    privacy: "public",
    description: null,
  });
  expect(playlistDetails(page())).toMatchObject({ privacy: "private" });
});

// Fail closed: privacy is reported only from one exact label.
test("missing or conflicting privacy labels report null", () => {
  expect(playlistDetails(page({ privacy: [] }))).toMatchObject({
    privacy: null,
  });
  expect(
    playlistDetails(page({ privacy: ["Private", "Public"] })),
  ).toMatchObject({ privacy: null });
  expect(playlistDetails(page({ privacy: ["private"] }))).toMatchObject({
    privacy: null,
  });
  expect(playlistDetails(page({ header: false }))).toMatchObject({
    title: "Fixture title",
    privacy: null,
  });
});

test("a page with neither metadata nor header is unsupported", () => {
  expect(() => playlistDetails({})).toThrow();
  expect(() =>
    playlistDetails(page({ metadata: false, header: false })),
  ).toThrow();
});

async function connect(
  respond: () => unknown = () =>
    page({ privacy: ["Unlisted"], description: "d" }),
) {
  const browses: Record<string, unknown>[] = [];
  const browser = cdpFixture({
    cookies: [cookie({ value: "fixture-secret" })],
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.json();
      if (body.browseId === "SPaccount_advanced")
        return Response.json(accountPage("UCaaaaaaaaaaaaaaaaaaaaaa"));
      browses.push(body);
      return Response.json(respond());
    },
  });
  const backend = createBackend({
    cdpUrl: browser.url,
    network: (request) => {
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = `127.0.0.1:${upstream.port}`;
      return fetch(new Request(url, request));
    },
  });
  const server = createServer(backend.reader);
  const client = new Client({ name: "playlist-details-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    browser.close();
    upstream.stop(true);
  });
  return { client, browses };
}

test("the details tool reads one playlist page and declares itself read-only", async () => {
  const { client, browses } = await connect();
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "youtube_get_playlist_details",
  );
  expect(tool?.annotations).toMatchObject({
    readOnlyHint: true,
    destructiveHint: false,
  });
  const result = await client.callTool({
    name: "youtube_get_playlist_details",
    arguments: { playlist_id: playlist },
  });
  expect(result.structuredContent).toEqual({
    account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
    playlist_id: playlist,
    title: "Fixture title",
    description: "d",
    privacy: "unlisted",
  });
  expect(browses).toEqual([
    expect.objectContaining({ browseId: `VL${playlist}` }),
  ]);
});

test("details take only a playlist ID, checked before any request", async () => {
  const { client, browses } = await connect();
  for (const args of [
    {},
    { playlist_id: "https://youtube.com/playlist?list=PL1" },
    { playlist_id: playlist, limit: 5 },
    { playlist_id: playlist, cursor: "x" },
  ]) {
    const result = await client.callTool({
      name: "youtube_get_playlist_details",
      arguments: args,
    });
    expect(result.isError).toBe(true);
  }
  expect(browses).toEqual([]);
});
