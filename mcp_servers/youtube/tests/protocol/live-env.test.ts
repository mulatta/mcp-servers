import { describe, expect, test } from "bun:test";
import { liveEnv } from "../live/env.ts";

const test_ = "UC" + "t".repeat(22);
const personal = "UC" + "p".repeat(22);
const base = { HOME: "/home/tester" };

describe("live test environment", () => {
  test("defaults the test browser to free loopback ports and XDG data", () => {
    const env = liveEnv(base);
    expect(env.neko).toEqual({
      name: "neko-yt-test",
      cdpPort: 9224,
      uiPort: 8083,
      mediaPort: 59224,
      dataDir: "/home/tester/.local/share/youtube-mcp/live-neko",
    });
    expect(env.cdpUrl).toBe("http://127.0.0.1:9224");
    expect(env.reads).toBe(false);
    expect(env.writes).toBe(false);
  });

  test("follows configured ports, name and XDG_DATA_HOME", () => {
    const env = liveEnv({
      ...base,
      XDG_DATA_HOME: "/data",
      YOUTUBE_LIVE_NEKO_NAME: "neko-other",
      YOUTUBE_LIVE_NEKO_CDP_PORT: "9300",
      YOUTUBE_LIVE_NEKO_UI_PORT: "8300",
      YOUTUBE_LIVE_NEKO_MEDIA_PORT: "59300",
    });
    expect(env.neko).toEqual({
      name: "neko-other",
      cdpPort: 9300,
      uiPort: 8300,
      mediaPort: 59300,
      dataDir: "/data/youtube-mcp/live-neko",
    });
    expect(env.cdpUrl).toBe("http://127.0.0.1:9300");
  });

  test("an explicit CDP URL wins over the test browser port", () => {
    const env = liveEnv({
      ...base,
      YOUTUBE_LIVE_CDP_URL: "http://10.0.0.2:9500",
    });
    expect(env.cdpUrl).toBe("http://10.0.0.2:9500");
  });

  test("an explicit data directory wins over XDG", () => {
    const env = liveEnv({ ...base, YOUTUBE_LIVE_NEKO_DATA_DIR: "/srv/neko" });
    expect(env.neko.dataDir).toBe("/srv/neko");
  });

  test.each([
    ["YOUTUBE_LIVE_NEKO_CDP_PORT", "80"],
    ["YOUTUBE_LIVE_NEKO_UI_PORT", "70000"],
    ["YOUTUBE_LIVE_NEKO_MEDIA_PORT", "59x"],
    ["YOUTUBE_LIVE_NEKO_NAME", "Bad Name"],
  ])("rejects an invalid %s", (key, value) => {
    expect(() => liveEnv({ ...base, [key]: value })).toThrow(key);
  });

  test("rejects two roles on one port", () => {
    expect(() =>
      liveEnv({
        ...base,
        YOUTUBE_LIVE_NEKO_UI_PORT: "9224",
      }),
    ).toThrow(/YOUTUBE_LIVE_NEKO_CDP_PORT.*YOUTUBE_LIVE_NEKO_UI_PORT/);
  });

  test("reads need YOUTUBE_LIVE=1; writes need YOUTUBE_LIVE_WRITES=1 too", () => {
    expect(liveEnv({ ...base, YOUTUBE_LIVE: "1" }).reads).toBe(true);
    expect(liveEnv({ ...base, YOUTUBE_LIVE_WRITES: "1" }).writes).toBe(false);
    const env = liveEnv({
      ...base,
      YOUTUBE_LIVE: "1",
      YOUTUBE_LIVE_WRITES: "1",
      YOUTUBE_LIVE_ACCOUNT_ID: test_,
      YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID: personal,
    });
    expect(env.writes).toBe(true);
    expect(env.accountId).toBe(test_);
    expect(env.personalAccountId).toBe(personal);
  });

  test.each([
    ["no pinned account", {}],
    ["no personal account", { YOUTUBE_LIVE_ACCOUNT_ID: test_ }],
    [
      "no pinned account but a personal one",
      {
        YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID: personal,
      },
    ],
  ])("writes refuse to run with %s", (_, extra) => {
    expect(() =>
      liveEnv({
        ...base,
        YOUTUBE_LIVE: "1",
        YOUTUBE_LIVE_WRITES: "1",
        ...extra,
      }),
    ).toThrow(/YOUTUBE_LIVE_(PERSONAL_)?ACCOUNT_ID/);
  });

  test("refuses a pinned account equal to the personal one, without naming it", () => {
    const run = () =>
      liveEnv({
        ...base,
        YOUTUBE_LIVE_ACCOUNT_ID: personal,
        YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID: personal,
      });
    expect(run).toThrow("YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID");
    try {
      run();
    } catch (error) {
      expect(String(error)).not.toContain(personal);
    }
  });

  test("rejects malformed channel IDs without echoing them", () => {
    const run = () =>
      liveEnv({ ...base, YOUTUBE_LIVE_ACCOUNT_ID: "secret-value" });
    expect(run).toThrow("YOUTUBE_LIVE_ACCOUNT_ID");
    try {
      run();
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });

  test("needs a home or data directory", () => {
    expect(() => liveEnv({})).toThrow("HOME");
  });
});
