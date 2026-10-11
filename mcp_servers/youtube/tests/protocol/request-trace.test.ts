import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { stage } from "../../src/observability/trace.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";

for (const outcome of ["ok", "error", "timeout", "cancelled"] as const)
  test(`MCP request emits exactly one ${outcome} summary, even after late completion`, async () => {
    const c = captureDiagnostics();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = {
      items: [{ title: "private-title" }],
      account_id: "private-account",
    };
    const server = createServer(
      async () =>
        stage("upstream.request", async () => {
          entered();
          if (outcome === "timeout" || outcome === "cancelled") await gate;
          if (outcome === "error") throw new Error("private-exception");
          return result;
        }),
      { logger: c.logger, timeoutMs: outcome === "timeout" ? 20 : 1000 },
    );
    const client = new Client({ name: "trace-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right);
    await client.connect(left);
    const controller = new AbortController();
    try {
      await client.listTools();
      await client.callTool({
        name: "youtube_get_watch_later",
        arguments: { limit: 0, cookie: "private-cookie" },
      });
      const pending = client
        .callTool(
          { name: "youtube_get_watch_later", arguments: { limit: 5 } },
          undefined,
          { signal: controller.signal },
        )
        .catch(() => null);
      await ready;
      if (outcome === "cancelled") controller.abort();
      const response = await pending;
      if (outcome === "ok") expect(response?.structuredContent).toEqual(result);
      if (outcome === "timeout")
        expect(JSON.stringify(response)).toContain("TIMEOUT");
      release();
      await Bun.sleep(5);
      const records = await c.finish();
      const summaries = records.filter(
        (record) => record.event === "request.end",
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        outcome,
        limit: 5,
        tool: "youtube_get_watch_later",
      });
      const endings = records.filter((record) => record.event === "stage.end");
      expect(endings).toHaveLength(1);
      expect(endings[0].outcome).toBe(outcome);
      if (outcome === "timeout" || outcome === "cancelled")
        expect(summaries[0].active_stages).toEqual([
          { stage: "upstream.request", stage_id: endings[0].stage_id },
        ]);
      expect(JSON.stringify(records)).not.toContain("private-");
    } finally {
      release();
      await client.close();
      await server.close();
    }
  });
