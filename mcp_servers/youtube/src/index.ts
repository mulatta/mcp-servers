import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type Reader } from "./server.ts";
import { createReader } from "./reader.ts";
import { readLogLevel } from "./config.ts";
import { Logger } from "./observability/logger.ts";

export async function start(
  reader?: Reader,
  options: { timeoutMs?: number } = {},
) {
  let logger: Logger | undefined;
  let failing = false;
  const fatal = () => {
    if (failing) return;
    failing = true;
    logger ??= new Logger("error");
    logger.emit({ event: "server.fatal", code: "PROCESS_FAILURE" });
    void logger.close().then(() => process.exit(1));
  };
  // Install before configuration or reader construction can expose an exception.
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  try {
    let level;
    try {
      level = readLogLevel();
    } catch {
      logger = new Logger("error");
      logger.emit({ event: "config.invalid", code: "INVALID_LOG_LEVEL" });
      await logger.close();
      process.exit(1);
    }
    logger = new Logger(level);
    const server = createServer(reader ?? createReader(), options);
    for (const event of ["SIGINT", "SIGTERM"] as const)
      process.once(event, () => {
        void server.close().then(() => process.exit(0), fatal);
      });
    await server.connect(new StdioServerTransport());
    logger.emit({ event: "server.start" });
  } catch {
    fatal();
  }
}

if (import.meta.main) await start();
