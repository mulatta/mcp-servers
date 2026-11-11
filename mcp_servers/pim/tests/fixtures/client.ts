import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WriteGroup } from "../../src/config.ts";
import { createServer } from "../../src/server.ts";
import { signedIn } from "./setup.ts";
import type { Logger } from "../../src/observability/logger.ts";

/** An MCP client connected in process to a server backed by a fake Stalwart. */
export async function connected(
  options: { writes?: WriteGroup[]; timeoutMs?: number; logger?: Logger } = {},
) {
  const env = await signedIn(options.logger ? { logger: options.logger } : {});
  const server = createServer(env.jmap, {
    writes: new Set(options.writes ?? []),
    timeoutMs: options.timeoutMs,
    logger: options.logger,
  });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text =
      (result.content as { type: string; text: string }[])[0]?.text ?? "";
    return {
      isError: result.isError === true,
      structured: result.structuredContent as Record<string, any> | undefined,
      error: result.isError
        ? (JSON.parse(text) as { code: string; message: string })
        : undefined,
    };
  };
  return {
    ...env,
    client,
    call,
    async stop() {
      await client.close();
      await server.close();
      await env.stop();
    },
  };
}
export type Connected = Awaited<ReturnType<typeof connected>>;
