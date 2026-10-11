import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpFixture, cookie } from "../fixtures/cdp.ts";
import { accountPage } from "../fixtures/account.ts";

for (const malformed of [false, true])
  test(`auth subprocess leaves no secrets on stdout, stderr, or disk (malformed=${malformed})`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "youtube-auth-"));
    const secret = crypto.randomUUID();
    const browser = cdpFixture({ cookies: [cookie({ value: secret })] });
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json(
          malformed
            ? {
                contents: {
                  unknownSecretRenderer: {
                    cookie: "fixture-secret",
                    authorization: "fixture-auth-secret",
                  },
                },
              }
            : accountPage("UCaaaaaaaaaaaaaaaaaaaaaa"),
        );
      },
    });
    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          new URL("../fixtures/auth-worker.ts", import.meta.url).pathname,
        ],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            HOME: cwd,
            XDG_CACHE_HOME: join(cwd, "cache"),
            XDG_CONFIG_HOME: join(cwd, "config"),
            XDG_DATA_HOME: join(cwd, "data"),
            XDG_STATE_HOME: join(cwd, "state"),
            FIXTURE_CDP: browser.url,
            FIXTURE_UPSTREAM: `http://127.0.0.1:${upstream.port}/`,
          },
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      for (const forbidden of [
        secret,
        "fixture-secret",
        "fixture-auth-secret",
        "SAPISID",
        "/devtools/browser/",
      ])
        expect(stdout).not.toContain(forbidden);
      const output = JSON.parse(stdout);
      if (malformed) expect(output.isError).toBe(true);
      else expect(output.account_id).toBe("UCaaaaaaaaaaaaaaaaaaaaaa");
      const entries = await readdir(cwd, {
        recursive: true,
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const path = join(entry.parentPath, entry.name);
        // Bun may cache compiled source, but no runtime credentials may reach disk.
        expect(path.startsWith(join(cwd, "cache", "bun") + "/")).toBe(true);
        expect(entry.name.endsWith(".pile")).toBe(true);
        expect((await readFile(path)).includes(Buffer.from(secret))).toBe(
          false,
        );
      }
      expect(browser.forbidden).toBe(false);
    } finally {
      browser.close();
      upstream.stop(true);
      await rm(cwd, { recursive: true, force: true });
    }
  });
