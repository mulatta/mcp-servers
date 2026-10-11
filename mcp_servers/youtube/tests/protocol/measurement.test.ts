import { expect, test } from "bun:test";
import { libraryServer } from "../fixtures/library-server.ts";
import { observedMcp } from "../fixtures/observed-mcp.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";

const tool = "youtube_get_watch_later";

test("external cold, warm and same-cursor conditions match real protocol traffic", async () => {
  const f = libraryServer({ pages: [4] });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const m = await observedMcp(f);
      try {
        const result = await m.client.callTool({
          name: tool,
          arguments: { limit: 1 },
        });
        expect(result.isError).not.toBe(true);
      } finally {
        const summaries = (await m.close()).filter(
          (r) => r.event === "request.end",
        );
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatchObject({
          outcome: "ok",
          auth_cache: "miss",
          page_cache: "miss",
          returned_count: 1,
        });
      }
    }
    expect(f.browser.discoveries).toBe(5);
    expect(f.reads).toBe(5);
    const warm = await observedMcp(f);
    try {
      for (let attempt = 0; attempt < 6; attempt++)
        await warm.client.callTool({ name: tool, arguments: { limit: 1 } });
    } finally {
      const summaries = (await warm.close()).filter(
        (r) => r.event === "request.end",
      );
      expect(summaries).toHaveLength(6);
      expect(summaries[0].auth_cache).toBe("miss");
      expect(
        summaries
          .slice(1)
          .every(
            (r) =>
              r.auth_cache === "hit" &&
              r.page_cache === "miss" &&
              r.outcome === "ok",
          ),
      ).toBe(true);
    }
    expect(f.browser.discoveries).toBe(6);
    expect(f.reads).toBe(11);
    const replay = await observedMcp(f);
    let cursor = "";
    try {
      const first = resultSchema.parse(
        (await replay.client.callTool({ name: tool, arguments: { limit: 1 } }))
          .structuredContent,
      );
      cursor = first.next_cursor!;
      expect(cursor).not.toBeNull();
      const args = { limit: 1, cursor };
      const prepared = await replay.client.callTool({
        name: tool,
        arguments: args,
      });
      for (let attempt = 0; attempt < 5; attempt++)
        expect(
          await replay.client.callTool({ name: tool, arguments: args }),
        ).toEqual(prepared);
    } finally {
      const records = await replay.close();
      const summaries = records.filter((r) => r.event === "request.end");
      expect(summaries).toHaveLength(7);
      expect(
        summaries
          .slice(2)
          .every(
            (r) =>
              r.auth_cache === "hit" &&
              r.page_cache === "replay" &&
              r.outcome === "ok",
          ),
      ).toBe(true);
      expect(JSON.stringify(records)).not.toContain(cursor);
    }
    expect(f.browser.discoveries).toBe(7);
    expect(f.reads).toBe(12);
    expect(f.paths).toHaveLength(19);
  } finally {
    f.close();
  }
}, 15000);
