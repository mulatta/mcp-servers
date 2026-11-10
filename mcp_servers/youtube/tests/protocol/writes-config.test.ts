import { expect, test } from "bun:test";
import { ConfigError, readWrites } from "../../src/config.ts";

test("writes stay off unless YOUTUBE_WRITES names groups", () => {
  expect([...readWrites({})]).toEqual([]);
  expect([...readWrites({ YOUTUBE_WRITES: "" })]).toEqual([]);
});

test("groups are enabled one by one, and all enables every group", () => {
  expect([...readWrites({ YOUTUBE_WRITES: "playlist" })]).toEqual(["playlist"]);
  expect(
    [...readWrites({ YOUTUBE_WRITES: "rating, playlist" })].sort(),
  ).toEqual(["playlist", "rating"]);
  expect([...readWrites({ YOUTUBE_WRITES: "playlist,playlist" })]).toEqual([
    "playlist",
  ]);
  expect([...readWrites({ YOUTUBE_WRITES: "all" })].sort()).toEqual([
    "notification",
    "playlist",
    "rating",
    "subscription",
  ]);
});

// Fail closed: a typo must not silently enable or disable a group.
for (const value of [
  "comment",
  "Playlist",
  "playlist,",
  ",",
  " ",
  "all,playlist",
  "none",
  "playlist;rating",
  "true",
  "1",
])
  test(`YOUTUBE_WRITES=${JSON.stringify(value)} is refused`, () => {
    expect(() => readWrites({ YOUTUBE_WRITES: value })).toThrow(ConfigError);
  });

function spawn(env: Record<string, string>) {
  return Bun.spawn(
    [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "",
        YOUTUBE_CDP_URL: "http://127.0.0.1:1",
        ...env,
      },
    },
  );
}

test("an invalid YOUTUBE_WRITES exits before serving", async () => {
  const child = spawn({ YOUTUBE_WRITES: "comment" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({
    level: "error",
    event: "config.invalid",
    code: "INVALID_WRITES",
  });
});

test("server.start reports the enabled write groups", async () => {
  const child = spawn({ YOUTUBE_WRITES: "rating,playlist" });
  const reader = child.stderr.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  child.stdin.end();
  await child.exited;
  const start = JSON.parse(text.split("\n")[0]!);
  expect(start).toMatchObject({ event: "server.start" });
  expect([...start.writes].sort()).toEqual(["playlist", "rating"]);
});
