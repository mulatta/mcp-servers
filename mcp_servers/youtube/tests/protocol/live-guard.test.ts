import { expect, test } from "bun:test";
import { cdpFixture } from "../fixtures/cdp.ts";

test("live command without explicit opt-in makes no browser requests", async () => {
  const browser = cdpFixture({ noPage: true });
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../integration/live.ts", import.meta.url).pathname,
      ],
      {
        env: {
          ...process.env,
          YOUTUBE_LIVE_READONLY: "",
          YOUTUBE_CDP_URL: browser.url,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("disabled");
    expect(browser.discoveries).toBe(0);
    expect(browser.connections).toBe(0);
  } finally {
    browser.close();
  }
});
