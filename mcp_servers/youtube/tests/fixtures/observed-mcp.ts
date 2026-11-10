import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { LogLevel } from "../../src/config.ts";
import type { libraryServer } from "./library-server.ts";
import { DiagnosticCollector } from "../integration/diagnostics.ts";

export async function observedMcp(
  fixture: ReturnType<typeof libraryServer>,
  level: LogLevel = "info",
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("./mcp-worker.ts", import.meta.url).pathname],
    env: {
      FIXTURE_CDP: fixture.browser.url,
      FIXTURE_UPSTREAM: `127.0.0.1:${fixture.upstream.port}`,
      YOUTUBE_LOG_LEVEL: level,
    },
    stderr: "pipe",
  });
  const collector = new DiagnosticCollector();
  let text = "";
  let overflow = false;
  transport.stderr?.on("data", (chunk) => {
    collector.push(chunk);
    if (text.length + chunk.length > 1024 * 1024) overflow = true;
    else if (!overflow) text += chunk.toString();
  });
  const client = new Client({ name: "observed-fixture", version: "1" });
  try {
    await client.connect(transport, { timeout: 3000 });
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    client,
    async close() {
      await client.close();
      if (!collector.finish().valid || overflow)
        throw new Error("Invalid fixture diagnostics.");
      return text.trim()
        ? text
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
    },
  };
}
