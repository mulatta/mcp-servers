import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { libraryServer } from "../fixtures/library-server.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { toolNames } from "../../src/server.ts";

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

test("stdio to CDP and upstream: five reads, cancellation, deadline, account pin and secrets", async () => {
  const f = libraryServer({ pages: [4] });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../fixtures/mcp-worker.ts", import.meta.url).pathname],
    stderr: "pipe",
    env: {
      FIXTURE_CDP: f.browser.url,
      FIXTURE_UPSTREAM: `127.0.0.1:${f.upstream.port}`,
    },
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "integration", version: "1" });
  const responses: unknown[] = [];
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
    }
    f.stall = true;
    const timedOut = await call();
    expect(JSON.stringify(timedOut)).toContain("TIMEOUT");
    await until(() => f.aborted === 1);
    const controller = new AbortController();
    const before = f.reads;
    const pending = client
      .callTool({ name: "youtube_get_watch_later", arguments: {} }, undefined, {
        signal: controller.signal,
      })
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
    expect(f.paths.every((path) => path === "/youtubei/v1/browse")).toBe(true);
    expect(f.browser.forbidden).toBe(false);
    for (const secret of ["fixture-secret", "SAPISID", "/devtools/browser/"])
      expect(JSON.stringify(responses)).not.toContain(secret);
  } finally {
    await client.close();
    f.close();
  }
  expect(stderr).toBe("");
}, 5000);
