import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type Reader } from "./server.ts";
import { createReader } from "./reader.ts";
import { readLogLevel } from "./config.ts";
import { Logger } from "./observability/logger.ts";

export async function start(
  reader?: Reader,
  options: { timeoutMs?: number; logger?: Logger } = {},
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
    const diagnostics = options.logger ?? new Logger(level);
    logger = diagnostics;
    const server = createServer(reader ?? createReader(), {
      ...options,
      logger: diagnostics,
    });
    let closing = false;
    const stop = async (reason: "SIGINT" | "SIGTERM" | "transport_closed") => {
      if (closing || failing) return;
      closing = true;
      try {
        await server.close();
        diagnostics.emit({ event: "server.stop", reason });
        await diagnostics.close();
        process.exit(0);
      } catch {
        fatal();
      }
    };
    for (const event of ["SIGINT", "SIGTERM"] as const)
      process.on(event, () => {
        void stop(event);
      });
    server.server.onclose = () => {
      void stop("transport_closed");
    };
    // The SDK transport does not translate stdin EOF into onclose.
    process.stdin.once("end", () => {
      void stop("transport_closed");
    });
    await server.connect(new StdioServerTransport());
    diagnostics.emit({ event: "server.start" });
  } catch {
    fatal();
  }
}

if (import.meta.main) await start();
