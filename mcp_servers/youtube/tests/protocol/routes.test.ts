import { expect, test } from "bun:test";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { accountPage } from "../fixtures/account.ts";

async function connect() {
  const paths: string[] = [];
  const signal = new AbortController().signal;
  const session = await YoutubeClient.connect(
    "SAPISID=fixture",
    signal,
    async (req) => {
      paths.push(new URL(req.url).pathname);
      return Response.json(
        paths.length === 1 ? accountPage("UCaaaaaaaaaaaaaaaaaaaaaa") : {},
      );
    },
  );
  paths.length = 0;
  return { client: session.value, paths, signal };
}

test("an operation reaches only the routes it names", async () => {
  const { client, paths, signal } = await connect();
  await client.use(
    signal,
    (yt) => yt.actions.execute("/browse/edit_playlist", {}),
    ["edit_playlist"],
  );
  for (const endpoint of [
    "/browse",
    "/like/like",
    "/playlist/delete",
    "/player",
  ])
    await expect(
      client.use(signal, (yt) => yt.actions.execute(endpoint, {}), [
        "edit_playlist",
      ]),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(paths).toEqual(["/youtubei/v1/browse/edit_playlist"]);
});

test("routes match whole paths, never prefixes", async () => {
  const { client, paths, signal } = await connect();
  for (const endpoint of ["/browse/edit_playlist", "/browsex", "/browse/"])
    await expect(
      client.use(signal, (yt) => yt.actions.execute(endpoint, {})),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  expect(paths).toEqual([]);
});

test("an empty route list reaches nothing", async () => {
  const { client, paths, signal } = await connect();
  await expect(
    client.use(
      signal,
      (yt) => yt.actions.execute("/browse", { browseId: "FEchannels" }),
      [],
    ),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(paths).toEqual([]);
});

test("a write route granted to one call does not leak into a concurrent read", async () => {
  const { client, paths, signal } = await connect();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const writer = client.use(
    signal,
    async (yt) => {
      await held;
      return yt.actions.execute("/browse/edit_playlist", {});
    },
    ["edit_playlist"],
  );
  await expect(
    client.use(signal, (yt) => yt.actions.execute("/browse/edit_playlist", {})),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  release();
  await writer;
  expect(paths).toEqual(["/youtubei/v1/browse/edit_playlist"]);
});
