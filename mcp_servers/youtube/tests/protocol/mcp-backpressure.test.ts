import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PipeMcp } from "../fixtures/pipe-mcp.ts";
import { libraryServer } from "../fixtures/library-server.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

for (const broken of [false, true])
  test(`MCP reads, deadlines and cancellation survive unavailable stderr (broken=${broken})`, async () => {
    const f = libraryServer();
    const transport = new PipeMcp(f, broken);
    const client = new Client({ name: "backpressure-test", version: "1" });
    const call = () =>
      client.callTool({
        name: "youtube_get_watch_later",
        arguments: { limit: 1 },
      });
    try {
      await client.connect(transport, { timeout: 3000 });
      expect((await client.listTools()).tools).toHaveLength(5);
      expect((await call()).isError).not.toBe(true);
      f.stall = true;
      expect(JSON.stringify(await call())).toContain("TIMEOUT");
      await until(() => f.aborted === 1);
      const before = f.reads;
      const controller = new AbortController();
      const pending = client
        .callTool(
          { name: "youtube_get_watch_later", arguments: { limit: 1 } },
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
      expect((await call()).isError).not.toBe(true);
      expect(f.browser.discoveries).toBe(1);
      await client.close();
      expect(await transport.exited).toBe(0);
    } finally {
      await client.close();
      f.close();
    }
  }, 10000);
