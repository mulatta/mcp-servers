import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const names = [
  "youtube_get_liked_videos",
  "youtube_get_playlist",
  "youtube_get_watch_history",
  "youtube_get_watch_later",
  "youtube_list_playlists",
];

test("stdio discovery works without browser credentials and exposes only five reads", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/index.ts"],
    cwd: root,
    env: { YOUTUBE_CDP_URL: "http://127.0.0.1:1" },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const client = new Client({ name: "protocol-test", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 2000 });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(names);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
    }
    const result = await client.callTool({
      name: "youtube_get_watch_later",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("127.0.0.1");
  } finally {
    await client.close();
  }
  expect(diagnostics).toBe("");
});
