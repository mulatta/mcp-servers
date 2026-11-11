import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile } from "node:fs/promises";
import { login } from "./auth/login.ts";
import { Credentials, TokenStore } from "./auth/tokens.ts";
import {
  ConfigError,
  readLogLevel,
  readServer,
  readTransport,
  readWrites,
  type ServerConfig,
  type TransportConfig,
  type WriteGroup,
} from "./config.ts";
import { startHttp, validToken } from "./http.ts";
import { Jmap } from "./jmap/client.ts";
import { Logger } from "./observability/logger.ts";
import { createServer } from "./server.ts";

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

/** `pim-mcp login`: the one interactive step, run by the operator. */
async function runLogin() {
  let config: ServerConfig;
  try {
    config = readServer();
  } catch {
    console.error(
      "Set PIM_SERVER_URL to the Stalwart origin, e.g. https://mail.example.org.",
    );
    process.exit(2);
  }
  try {
    await login(config, new TokenStore(config.stateDir), {
      print: (line) => console.error(line),
    });
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Login failed.");
    process.exit(1);
  }
}

export async function start(options: { timeoutMs?: number } = {}) {
  let logger: Logger | undefined;
  let failing = false;
  const fatal = () => {
    if (failing) return;
    failing = true;
    logger ??= new Logger("error");
    logger.emit({ event: "server.fatal", code: "PROCESS_FAILURE" });
    void logger.close().then(() => process.exit(1));
  };
  // Install before configuration can expose an exception.
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
    const diagnostics = new Logger(level);
    logger = diagnostics;
    const refuse = async (error: unknown): Promise<never> => {
      if (!(error instanceof ConfigError)) throw error;
      diagnostics.emit({ event: "config.invalid", code: error.code });
      await diagnostics.close();
      process.exit(1);
    };
    let server: ServerConfig;
    let transport: TransportConfig;
    let token = "";
    let writes: ReadonlySet<WriteGroup>;
    try {
      server = readServer();
      writes = readWrites();
      transport = readTransport();
      if (transport.kind === "http")
        token = await readToken(transport.tokenFile);
    } catch (error) {
      return refuse(error);
    }
    const credentials = new Credentials(
      server,
      new TokenStore(server.stateDir),
      {
        logger: diagnostics,
      },
    );
    const jmap = new Jmap(server, credentials, { logger: diagnostics });
    // Logged so an operator can see from the journal whether writes are on.
    const started = writes.size ? { writes: [...writes] } : {};
    let closing = false;
    let close = async () => {};
    const stopRefresh = credentials.startBackground();
    const stop = async (reason: "SIGINT" | "SIGTERM" | "transport_closed") => {
      if (closing || failing) return;
      closing = true;
      try {
        stopRefresh();
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
      const http = await startHttp(jmap, {
        ...transport,
        token,
        logger: diagnostics,
        timeoutMs: options.timeoutMs,
        writes,
      }).catch(refuse);
      close = () => http.stop();
      diagnostics.emit({ event: "server.start", ...started });
      return;
    }
    const mcp = createServer(jmap, { ...options, logger: diagnostics, writes });
    close = () => mcp.close();
    mcp.server.onclose = () => {
      void stop("transport_closed");
    };
    // The SDK transport does not translate stdin EOF into onclose.
    process.stdin.once("end", () => {
      void stop("transport_closed");
    });
    await mcp.connect(new StdioServerTransport());
    diagnostics.emit({ event: "server.start", ...started });
  } catch {
    fatal();
  }
}

if (import.meta.main) {
  if (process.argv[2] === "login") await runLogin();
  else if (process.argv.length > 2) {
    console.error("Usage: pim-mcp [login]");
    process.exit(2);
  } else await start();
}
