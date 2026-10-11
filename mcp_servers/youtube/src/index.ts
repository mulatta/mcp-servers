import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type Reader } from "./server.ts";
import { createReader } from "./reader.ts";

function fatal() {
  process.stderr.write(
    "YouTube MCP stopped unexpectedly. Restart and retry.\n",
  );
  process.exit(1);
}

export async function start(
  reader: Reader = createReader(),
  options: { timeoutMs?: number } = {},
) {
  // Unhandled failures must not let the runtime print credential-bearing stacks.
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  const server = createServer(reader, options);
  for (const event of ["SIGINT", "SIGTERM"] as const)
    process.once(event, () => {
      void server.close().then(() => process.exit(0), fatal);
    });
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) await start().catch(fatal);
