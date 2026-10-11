import { expect, test } from "bun:test";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { accountPage } from "../fixtures/account.ts";
import { normalize } from "../../src/youtube/normalize.ts";

const cases: [number, unknown, string][] = [
  [401, {}, "AUTH_REQUIRED"],
  [403, {}, "PLAYLIST_UNAVAILABLE"],
  [429, {}, "RATE_LIMITED"],
  [200, { error: { status: "UNAUTHENTICATED" } }, "AUTH_REQUIRED"],
  [
    403,
    { error: { message: "Sign in to confirm you’re not a bot" } },
    "UPSTREAM_BLOCKED",
  ],
  [
    200,
    {
      playabilityStatus: {
        status: "LOGIN_REQUIRED",
        reason: "Sign in to confirm you're not a bot",
      },
    },
    "UPSTREAM_BLOCKED",
  ],
  [200, { playabilityStatus: { status: "LOGIN_REQUIRED" } }, "AUTH_REQUIRED"],
  [
    200,
    {
      alerts: [
        {
          alertRenderer: {
            type: "ERROR",
            text: { simpleText: "The playlist does not exist." },
          },
        },
      ],
    },
    "PLAYLIST_UNAVAILABLE",
  ],
  [500, {}, "UPSTREAM_UNAVAILABLE"],
  [200, { newResponse: true }, "AUTH_REQUIRED"],
];
for (const [status, data, code] of cases)
  test(`safe upstream status ${status} -> ${code}: ${JSON.stringify(data)}`, async () => {
    await expect(
      YoutubeClient.connect(
        "SAPISID=fixture",
        new AbortController().signal,
        async () => Response.json(data, { status }),
      ),
    ).rejects.toMatchObject({ code });
  });

test("arbitrary messages are not treated as empty library responses", () => {
  expect(() =>
    normalize(
      {
        contents: {
          messageRenderer: {
            text: { simpleText: "Sign in to view this page" },
          },
        },
      },
      "videos",
    ),
  ).toThrow();
});

test("redirects and mutation endpoints cannot carry cookies outside read boundary", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const session = await YoutubeClient.connect(
    "SAPISID=fixture",
    signal,
    async (req) => {
      calls++;
      expect(req.redirect).toBe("error");
      return Response.json(accountPage("UCaaaaaaaaaaaaaaaaaaaaaa"));
    },
  );
  for (const endpoint of [
    "/like/like",
    "/feedback",
    "/browse/edit_playlist",
    "/player",
    "/playlist/create",
  ]) {
    await expect(
      session.value.use(signal, (yt) => yt.actions.execute(endpoint, {})),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  }
  expect(calls).toBe(1);
});

test("connection failures are sanitized", async () => {
  await expect(
    YoutubeClient.connect(
      "SAPISID=fixture",
      new AbortController().signal,
      async () => {
        throw new Error("Cookie secret Authorization secret");
      },
    ),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
});
