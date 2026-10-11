import { expect, test } from "bun:test";

test("invalid log configuration exits safely before browser access", async () => {
  const child = Bun.spawn(
    [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        YOUTUBE_LOG_LEVEL: "secret\ninvalid",
        YOUTUBE_CDP_URL: "https://private-endpoint.invalid/",
      },
    },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).not.toContain("secret");
  expect(stderr).not.toContain("private-endpoint");
  expect(JSON.parse(stderr)).toMatchObject({
    level: "error",
    event: "config.invalid",
    code: "INVALID_LOG_LEVEL",
  });
});

test("fatal process errors emit fixed JSONL without exception details", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("../fixtures/fatal-worker.ts", import.meta.url).pathname,
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, YOUTUBE_LOG_LEVEL: "info" },
    },
  );
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("private-cookie-and-account");
    const records = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event)).toEqual([
      "server.start",
      "server.fatal",
    ]);
    expect(records[1]).toMatchObject({
      level: "error",
      code: "PROCESS_FAILURE",
    });
  } finally {
    child.kill();
    await child.exited;
  }
});
