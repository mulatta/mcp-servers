import { createHash, timingSafeEqual } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConfigError } from "./config.ts";
import { createServer, type Reader } from "./server.ts";
import type { Logger } from "./observability/logger.ts";

export const endpoint = "/mcp";
const tokenPattern = /^[\x21-\x7e]{32,}$/;
// Excludes userinfo, path, query and fragment so URL parsing cannot relocate the hostname.
const hostPattern = /^[A-Za-z0-9.:[\]-]+$/;

export interface HttpOptions {
  hostname: string;
  port: number;
  token: string;
  allowedHosts: string[];
  logger?: Logger | undefined;
  timeoutMs?: number | undefined;
}

export function validToken(token: string) {
  return tokenPattern.test(token);
}

function hostnameOf(header: string | null): string | undefined {
  if (!header || !hostPattern.test(header)) return;
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return;
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

const rejection = (status: 401 | 403 | 404 | 405) =>
  new Response(null, {
    status,
    headers: {
      ...(status === 401 && {
        "www-authenticate": 'Bearer realm="youtube-mcp"',
      }),
      ...(status === 405 && { allow: "POST" }),
    },
  });

export async function startHttp(reader: Reader, options: HttpOptions) {
  if (!validToken(options.token)) throw new ConfigError("INVALID_HTTP_CONFIG");
  // Each entry is checked on its own; spellings of one hostname may repeat.
  const parsed = options.allowedHosts.map(hostnameOf);
  if (!parsed.length || parsed.some((host) => !host))
    throw new ConfigError("INVALID_HTTP_CONFIG");
  const allowed = new Set(parsed);
  // Hashing first gives timingSafeEqual equal-length inputs for any presented token.
  const expected = digest(options.token);
  const authorized = (header: string | null) => {
    const presented = header && /^Bearer ([\x21-\x7e]+)$/.exec(header)?.[1];
    return !!presented && timingSafeEqual(digest(presented), expected);
  };
  const reject = (status: 401 | 403 | 404 | 405) => {
    options.logger?.emit({ event: "http.rejected", status });
    return rejection(status);
  };

  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    async fetch(request) {
      // Host first: a rebinding page must not learn whether a token is accepted.
      if (!allowed.has(hostnameOf(request.headers.get("host"))))
        return reject(403);
      if (!authorized(request.headers.get("authorization"))) return reject(401);
      if (new URL(request.url).pathname !== endpoint) return reject(404);
      // Stateless mode answers each POST with JSON; there is no server-initiated stream to hold open.
      if (request.method !== "POST") return reject(405);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const mcp = createServer(reader, {
        logger: options.logger,
        timeoutMs: options.timeoutMs,
      });
      await mcp.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await mcp.close();
      }
    },
  });
  const host = options.hostname.includes(":")
    ? `[${options.hostname}]`
    : options.hostname;
  return {
    url: new URL(`http://${host}:${server.port}${endpoint}`),
    async stop() {
      await server.stop(true);
    },
  };
}
