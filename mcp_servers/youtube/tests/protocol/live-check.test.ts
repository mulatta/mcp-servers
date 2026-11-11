import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, toolNames, type ReadInput } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { libraryServer } from "../fixtures/library-server.ts";
import { checkTools } from "../integration/check-tools.ts";

test("live check calls every MCP tool with limit five and discovers the playlist ID", async () => {
  const f = libraryServer({ pages: [100] });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const calls: { name: string; input: ReadInput }[] = [];
  const server = createServer((name, input, signal) => {
    calls.push({ name, input });
    return backend.reader(name, input, signal);
  });
  const client = new Client({ name: "live-check-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const reports = await checkTools(client);
    // The details read reuses the playlist ID found by the first list read.
    expect(calls.map((c) => c.name)).toEqual([
      ...toolNames,
      "youtube_get_playlist_details",
    ]);
    expect(
      calls.slice(0, -1).every((c) => c.input.limit === 5 && !c.input.cursor),
    ).toBe(true);
    expect(calls[1]!.input.playlist_id).toBe("PLfixture0000000016");
    expect(calls.at(-1)!.input.playlist_id).toBe("PLfixture0000000016");
    expect(reports.map((r) => r.items)).toEqual([
      2,
      5,
      5,
      5,
      5,
      2,
      2,
      2,
      undefined,
    ]);
    // Fixture lockups carry no count badge and only history names channels.
    expect(reports.map((r) => r.null_fields)).toEqual([
      ["video_count"],
      ["channel_name"],
      ["channel_name"],
      ["channel_name"],
      [],
      [],
      ["channel_name"],
      [],
      // The fixture playlist page has a title but no description or privacy label.
      ["description", "privacy"],
    ]);
    expect(
      reports.every((r) => r.status === "ok" && r.account_consistent),
    ).toBe(true);
    expect(JSON.stringify(reports)).not.toContain("UCaaaaaaaa");
    expect(JSON.stringify(reports)).not.toContain("PLfixture");
    expect(JSON.stringify(reports)).not.toContain("Fixture 0");
    const result = await client.callTool({
      name: "youtube_get_watch_later",
      arguments: {},
    });
    expect(calls.at(-1)!.input.limit).toBe(50);
    expect(resultSchema.parse(result.structuredContent).items).toHaveLength(50);
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});
