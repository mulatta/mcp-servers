import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { libraryServer } from "../fixtures/library-server.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { toolNames } from "../../src/server.ts";
import { validDiagnostic } from "../../src/observability/logger.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

for (const level of ["info", "debug"] as const)
  test(`stdio to CDP/upstream preserves five tools, interruption and privacy (${level})`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "youtube-observability-"));
    const secret = crypto.randomUUID();
    const f = libraryServer({ pages: [4], cookieValue: secret });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [new URL("../fixtures/mcp-worker.ts", import.meta.url).pathname],
      cwd,
      stderr: "pipe",
      env: {
        FIXTURE_CDP: f.browser.url,
        FIXTURE_UPSTREAM: `127.0.0.1:${f.upstream.port}`,
        YOUTUBE_LOG_LEVEL: level,
        HOME: cwd,
        XDG_CACHE_HOME: join(cwd, "cache"),
        XDG_CONFIG_HOME: join(cwd, "config"),
        XDG_DATA_HOME: join(cwd, "data"),
        XDG_STATE_HOME: join(cwd, "state"),
      },
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "integration", version: "1" });
    const responses: unknown[] = [];
    const forbidden = new Set([
      secret,
      "fixture-secret",
      "SAPISID",
      "/devtools/browser/",
      "UCaaaaaaaaaaaaaaaaaaaaaa",
      "UCbbbbbbbbbbbbbbbbbbbbbb",
      "PLfixture",
    ]);
    const call = async () => {
      const result = await client.callTool({
        name: "youtube_get_watch_later",
        arguments: { limit: 1 },
      });
      responses.push(result);
      return result;
    };
    try {
      await client.connect(transport, { timeout: 3000 });
      expect((await client.listTools()).tools).toHaveLength(5);
      expect(f.browser.discoveries).toBe(0);
      expect(f.paths).toEqual([]);
      const concurrent = await Promise.all([call(), call()]);
      expect(concurrent.every((result) => !result.isError)).toBe(true);
      expect(f.browser.discoveries).toBe(1);
      for (const name of toolNames) {
        const result = await client.callTool({
          name,
          arguments: {
            limit: 1,
            ...(name === "youtube_get_playlist"
              ? { playlist_id: "PLfixture" }
              : {}),
          },
        });
        responses.push(result);
        expect(result.isError).not.toBe(true);
        const output = resultSchema.parse(result.structuredContent);
        expect(output.account_id).toBe("UCaaaaaaaaaaaaaaaaaaaaaa");
        expect(output.items).toHaveLength(1);
        expect(result.content).toEqual([
          { type: "text", text: JSON.stringify(output) },
        ]);
        if (output.next_cursor) forbidden.add(output.next_cursor);
        for (const item of output.items) {
          if (item.title) forbidden.add(item.title);
          if ("video_id" in item && item.video_id) forbidden.add(item.video_id);
          if ("playlist_id" in item && item.playlist_id)
            forbidden.add(item.playlist_id);
        }
      }
      f.stall = true;
      expect(JSON.stringify(await call())).toContain("TIMEOUT");
      await until(() => f.aborted === 1);
      const controller = new AbortController();
      const before = f.reads;
      const pending = client
        .callTool(
          { name: "youtube_get_watch_later", arguments: {} },
          undefined,
          { signal: controller.signal },
        )
        .then(
          () => false,
          () => true,
        );
      await until(() => f.reads > before);
      controller.abort();
      expect(await pending).toBe(true);
      await until(() => f.aborted === 2);
      f.stall = false;
      f.accountId = "UCbbbbbbbbbbbbbbbbbbbbbb";
      f.authFailures = 1;
      expect(JSON.stringify(await call())).toContain("ACCOUNT_CHANGED");
      expect(JSON.stringify(await call())).toContain("ACCOUNT_CHANGED");
      const count = f.reads;
      await client
        .callTool({ name: "youtube_delete_playlist", arguments: {} })
        .catch(() => undefined);
      expect(f.reads).toBe(count);
      expect(f.paths.every((path) => path === "/youtubei/v1/browse")).toBe(
        true,
      );
      expect(f.browser.forbidden).toBe(false);
      for (const value of [
        secret,
        "fixture-secret",
        "SAPISID",
        "/devtools/browser/",
      ])
        expect(JSON.stringify(responses)).not.toContain(value);
      await client.close();
      const records = stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.every(validDiagnostic)).toBe(true);
      expect(records.filter((r) => r.event === "server.start")).toHaveLength(1);
      expect(records.filter((r) => r.event === "server.stop")).toHaveLength(1);
      const summaries = records.filter((r) => r.event === "request.end");
      expect(summaries).toHaveLength(11);
      expect(new Set(summaries.map((r) => r.request_id)).size).toBe(11);
      expect(summaries.filter((r) => r.outcome === "ok")).toHaveLength(7);
      for (const outcome of ["timeout", "cancelled"]) {
        const interrupted = summaries.filter((r) => r.outcome === outcome);
        expect(interrupted).toHaveLength(1);
        expect(
          interrupted[0].active_stages.some(
            (r: { stage: string }) => r.stage === "upstream.request",
          ),
        ).toBe(true);
      }
      const stages = records.filter((r) => r.event === "stage.start");
      if (level === "info") expect(stages).toHaveLength(0);
      else {
        expect(stages.length).toBeGreaterThan(0);
        const ids = new Set(stages.map((r) => r.stage_id));
        expect(ids.size).toBe(stages.length);
        for (const stage of stages)
          if (stage.parent_stage_id)
            expect(ids.has(stage.parent_stage_id)).toBe(true);
        const waits = records.filter(
          (r) =>
            r.event === "stage.end" && r.stage === "auth.wait" && r.refresh_id,
        );
        expect(waits[0].refresh_id).toBe(waits[1].refresh_id);
      }
      for (const value of forbidden) expect(stderr).not.toContain(value);
      for (const entry of await readdir(cwd, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (entry.isDirectory()) continue;
        const path = join(entry.parentPath, entry.name);
        expect(path.startsWith(join(cwd, "cache", "bun") + "/")).toBe(true);
        expect(entry.name.endsWith(".pile")).toBe(true);
        expect((await readFile(path)).includes(Buffer.from(secret))).toBe(
          false,
        );
      }
    } finally {
      await client.close();
      f.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 10000);
