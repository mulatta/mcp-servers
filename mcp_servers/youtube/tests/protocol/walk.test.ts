import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { Paginator } from "../../src/pagination.ts";
import { walk } from "../../examples/walk.ts";
import { libraryServer } from "../fixtures/library-server.ts";

test("documented MCP traversal follows all pages and requires explicit expiry recovery", async () => {
  const f = libraryServer({ pages: [100, 3] });
  const pager = new Paginator(f.sessions);
  const server = createServer((name, input, signal) =>
    pager.read(name, input, signal),
  );
  const client = new Client({ name: "example-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const titles = [];
    for await (const page of walk(client, "youtube_get_watch_later", {
      limit: 20,
    }))
      titles.push(...page.items.map((x) => x.title));
    expect(titles).toEqual(
      Array.from({ length: 103 }, (_, i) => `Fixture ${i}`),
    );
    const iterator = walk(client, "youtube_get_watch_later", { limit: 20 });
    await iterator.next();
    f.sessions.invalidate();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
    });
    let restarted = 0;
    for await (const page of walk(client, "youtube_get_watch_later", {
      limit: 20,
    }))
      restarted += page.items.length;
    expect(restarted).toBe(103);
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});
