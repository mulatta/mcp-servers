import { describe, expect, test } from "bun:test";
import { accountUpdates, parseEnv, setEnv } from "../live/envfile.ts";

const file = `# Test browser
YOUTUBE_LIVE_NEKO_CDP_PORT=9300
YOUTUBE_LIVE_CDP_URL=http://127.0.0.1:9222

# Accounts
YOUTUBE_LIVE_ACCOUNT_ID=
# YOUTUBE_LIVE_ACCOUNT_ID=UCcommented
YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID=UCpersonal
`;

describe(".env.test edits", () => {
  test("parses assignments and skips comments and blanks", () => {
    expect(parseEnv(file)).toEqual({
      YOUTUBE_LIVE_NEKO_CDP_PORT: "9300",
      YOUTUBE_LIVE_CDP_URL: "http://127.0.0.1:9222",
      YOUTUBE_LIVE_ACCOUNT_ID: "",
      YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID: "UCpersonal",
    });
  });

  test("replaces a value in place and keeps every other line", () => {
    const next = setEnv(file, { YOUTUBE_LIVE_ACCOUNT_ID: "UCtest" });
    expect(next).toBe(
      file.replace(
        "YOUTUBE_LIVE_ACCOUNT_ID=\n",
        "YOUTUBE_LIVE_ACCOUNT_ID=UCtest\n",
      ),
    );
  });

  test("removes a key with null, leaving comments alone", () => {
    const next = setEnv(file, { YOUTUBE_LIVE_CDP_URL: null });
    expect(next).not.toContain("YOUTUBE_LIVE_CDP_URL");
    expect(next).toContain("# YOUTUBE_LIVE_ACCOUNT_ID=UCcommented");
    expect(next.split("\n").length).toBe(file.split("\n").length - 1);
  });

  test("appends a missing key with a trailing newline", () => {
    expect(setEnv("A=1", { B: "2" })).toBe("A=1\nB=2\n");
    expect(setEnv("", { B: "2" })).toBe("B=2\n");
  });

  test("removing an absent key changes nothing", () => {
    expect(setEnv(file, { MISSING: null })).toBe(file);
  });
});

describe("recording the test account", () => {
  const testAccount = "UC" + "t".repeat(22);
  const personal = "UC" + "p".repeat(22);
  const browser = "http://127.0.0.1:9224";

  test("refuses without the personal account to compare against", () => {
    expect(accountUpdates("", testAccount, "", browser)).toEqual({
      refuse: "set YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID in .env.test first",
    });
  });

  test("refuses when the test browser is signed into the personal account", () => {
    expect(accountUpdates("", personal, personal, browser)).toEqual({
      refuse:
        "the test browser is signed into YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID; sign in to the test account instead",
    });
  });

  test("records the account and drops a CDP URL naming another browser", () => {
    const text = `YOUTUBE_LIVE_CDP_URL=http://127.0.0.1:9222\nYOUTUBE_LIVE_PERSONAL_ACCOUNT_ID=${personal}\n`;
    expect(accountUpdates(text, testAccount, personal, browser)).toEqual({
      updates: {
        YOUTUBE_LIVE_ACCOUNT_ID: testAccount,
        YOUTUBE_LIVE_CDP_URL: null,
      },
    });
  });

  test("changes nothing once recorded", () => {
    const text = `YOUTUBE_LIVE_CDP_URL=${browser}\nYOUTUBE_LIVE_ACCOUNT_ID=${testAccount}\n`;
    expect(accountUpdates(text, testAccount, personal, browser)).toEqual({
      updates: {},
    });
  });
});
