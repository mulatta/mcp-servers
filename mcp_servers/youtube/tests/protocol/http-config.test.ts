import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "youtube-http-config-"));
const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
const secretPath = join(dir, "private-token-location");

afterAll(() => rm(dir, { recursive: true, force: true }));

async function freePort() {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const { port } = probe;
  await probe.stop(true);
  return port;
}

function spawn(env: Record<string, string>) {
  return Bun.spawn(
    [process.execPath, new URL("../../src/index.ts", import.meta.url).pathname],
    {
      stdin: "ignore",
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

async function expectRefusal(env: Record<string, string>, code: string) {
  const child = spawn(env);
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).not.toContain(token);
  expect(stderr).not.toContain("private-token-location");
  expect(JSON.parse(stderr)).toMatchObject({
    level: "error",
    event: "config.invalid",
    code,
  });
}

test("unknown transport exits before serving", async () => {
  await expectRefusal({ YOUTUBE_TRANSPORT: "websocket" }, "INVALID_TRANSPORT");
});

test("http transport without a token file exits before serving", async () => {
  await expectRefusal(
    { YOUTUBE_TRANSPORT: "http", YOUTUBE_HTTP_PORT: String(await freePort()) },
    "INVALID_HTTP_CONFIG",
  );
});

test("http transport with an unreadable token file exits before serving", async () => {
  await expectRefusal(
    {
      YOUTUBE_TRANSPORT: "http",
      YOUTUBE_HTTP_PORT: String(await freePort()),
      YOUTUBE_HTTP_TOKEN_FILE: secretPath,
    },
    "INVALID_HTTP_CONFIG",
  );
});

for (const [label, contents] of <[string, string][]>[
  ["empty", ""],
  ["whitespace", " \n"],
  ["short", "short\n"],
  ["multi-line", `${token}\n${token}\n`],
])
  test(`http transport with a ${label} token file exits before serving`, async () => {
    await writeFile(secretPath, contents);
    await expectRefusal(
      {
        YOUTUBE_TRANSPORT: "http",
        YOUTUBE_HTTP_PORT: String(await freePort()),
        YOUTUBE_HTTP_TOKEN_FILE: secretPath,
      },
      "INVALID_HTTP_CONFIG",
    );
  });

for (const port of ["", "0x50", "-1", "65536", "80 ", "abc"])
  test(`http transport with port ${JSON.stringify(port)} exits before serving`, async () => {
    await writeFile(secretPath, `${token}\n`);
    await expectRefusal(
      {
        YOUTUBE_TRANSPORT: "http",
        YOUTUBE_HTTP_PORT: port,
        YOUTUBE_HTTP_TOKEN_FILE: secretPath,
      },
      "INVALID_HTTP_CONFIG",
    );
  });

for (const hosts of ["evil@127.0.0.1", "127.0.0.1/path", ",", "127.0.0.1,"])
  test(`http transport with allowed hosts ${JSON.stringify(hosts)} exits before serving`, async () => {
    await writeFile(secretPath, `${token}\n`);
    await expectRefusal(
      {
        YOUTUBE_TRANSPORT: "http",
        YOUTUBE_HTTP_PORT: String(await freePort()),
        YOUTUBE_HTTP_TOKEN_FILE: secretPath,
        YOUTUBE_HTTP_ALLOWED_HOSTS: hosts,
      },
      "INVALID_HTTP_CONFIG",
    );
  });

test("valid http config keeps serving after stdin EOF and rejects anonymous requests", async () => {
  await writeFile(secretPath, `${token}\n`);
  const port = await freePort();
  const child = spawn({
    YOUTUBE_TRANSPORT: "http",
    YOUTUBE_HTTP_PORT: String(port),
    YOUTUBE_HTTP_TOKEN_FILE: secretPath,
  });
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 50 && !response; attempt++) {
      response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
      }).catch(() => undefined);
      if (!response) await Bun.sleep(100);
    }
    expect(response?.status).toBe(401);
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  }
  const stderr = await new Response(child.stderr).text();
  expect(stderr).not.toContain(token);
  expect(stderr).not.toContain("private-token-location");
}, 10_000);
