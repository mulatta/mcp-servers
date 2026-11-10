import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type Reader } from "./server.ts";
import { createBackend } from "./reader.ts";
import { readFile } from "node:fs/promises";
import {
  ConfigError,
  readLogLevel,
  readTransport,
  readWrites,
  type TransportConfig,
  type WriteGroup,
} from "./config.ts";
import { startHttp, validToken } from "./http.ts";
import { Logger } from "./observability/logger.ts";

async function readToken(path: string) {
  let token;
  try {
    token = (await readFile(path, "utf8")).replace(/\n$/, "");
  } catch {
    throw new ConfigError("INVALID_HTTP_CONFIG");
  }
  if (!validToken(token)) throw new ConfigError("INVALID_HTTP_CONFIG");
  return token;
}

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
    const refuse = async (error: unknown): Promise<never> => {
      if (!(error instanceof ConfigError)) throw error;
      diagnostics.emit({ event: "config.invalid", code: error.code });
      await diagnostics.close();
      process.exit(1);
    };
    let transport: TransportConfig;
    let token = "";
    let writes: ReadonlySet<WriteGroup>;
    try {
      writes = readWrites();
      transport = readTransport();
      if (transport.kind === "http")
        token = await readToken(transport.tokenFile);
    } catch (error) {
      return refuse(error);
    }
    // Logged so an operator can see from the journal whether writes are on.
    const started = writes.size ? { writes: [...writes] } : {};
    // An injected reader (tests) runs read-only; otherwise reads and writes share one session.
    const backend = reader ? { reader, writer: undefined } : createBackend();
    const shared = backend.reader;
    let closing = false;
    let close = async () => {};
    const stop = async (reason: "SIGINT" | "SIGTERM" | "transport_closed") => {
      if (closing || failing) return;
      closing = true;
      try {
        await close();
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
    if (transport.kind === "http") {
      const http = await startHttp(shared, {
        ...transport,
        token,
        logger: diagnostics,
        timeoutMs: options.timeoutMs,
        writer: backend.writer,
        writes,
      }).catch(refuse);
      close = () => http.stop();
      diagnostics.emit({ event: "server.start", ...started });
      return;
    }
    const server = createServer(shared, {
      ...options,
      logger: diagnostics,
      writer: backend.writer,
      writes,
    });
    close = () => server.close();
    server.server.onclose = () => {
      void stop("transport_closed");
    };
    // The SDK transport does not translate stdin EOF into onclose.
    process.stdin.once("end", () => {
      void stop("transport_closed");
    });
    await server.connect(new StdioServerTransport());
    diagnostics.emit({ event: "server.start", ...started });
  } catch {
    fatal();
  }
}

if (import.meta.main) await start();
