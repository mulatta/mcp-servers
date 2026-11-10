import { afterEach, expect, test } from "bun:test";
import { request } from "node:http";
import { startHttp } from "../../src/http.ts";
import type { Reader } from "../../src/server.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";
import { rpc } from "../fixtures/http.ts";

const token = "a".repeat(32) + crypto.randomUUID().replaceAll("-", "");
const servers: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

function spyReader() {
  const calls: string[] = [];
  const reader: Reader = async (name) => {
    calls.push(name);
    return { account_id: null, items: [], next_cursor: null, has_more: false };
  };
  return { calls, reader };
}

async function serve(reader: Reader, logger = captureDiagnostics().logger) {
  const server = await startHttp(reader, {
    hostname: "127.0.0.1",
    port: 0,
    token,
    allowedHosts: ["127.0.0.1"],
    logger,
  });
  servers.push(server);
  return server;
}

// node:http lets the test send an arbitrary Host header, unlike fetch.
function raw(
  url: URL,
  options: {
    path?: string | undefined;
    method?: string;
    headers?: Record<string, string>;
  },
) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "youtube_get_watch_history", arguments: {} },
  });
  return new Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: options.path ?? url.pathname,
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("authorized client reaches the reader (control for rejection tests)", async () => {
  const { calls, reader } = spyReader();
  const server = await serve(reader);
  const init = await rpc(server.url, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-test", version: "1.0.0" },
  });
  expect(init.result?.serverInfo).toMatchObject({ name: "youtube-mcp" });
  const list = await rpc(server.url, token, "tools/list", {});
  expect(list.result?.tools).toHaveLength(5);
  const call = await rpc(server.url, token, "tools/call", {
    name: "youtube_get_watch_history",
    arguments: {},
  });
  expect(call.result?.isError).toBeFalsy();
  expect(calls).toEqual(["youtube_get_watch_history"]);
});

const badCredentials: [string, Record<string, string>, string?][] = [
  ["missing header", {}],
  ["empty bearer", { authorization: "Bearer " }],
  ["wrong scheme", { authorization: `Basic ${token}` }],
  ["token without scheme", { authorization: token }],
  [
    "wrong token of equal length",
    { authorization: `Bearer ${"b".repeat(token.length)}` },
  ],
  ["token prefix", { authorization: `Bearer ${token.slice(0, -1)}` }],
  ["token with suffix", { authorization: `Bearer ${token}x` }],
  ["token in query", {}, `?token=${token}`],
];

for (const [label, headers, query] of badCredentials)
  test(`rejects ${label} with 401 before MCP or backend access`, async () => {
    const { calls, reader } = spyReader();
    const server = await serve(reader);
    const path = query && server.url.pathname + query;
    const response = await raw(server.url, { headers, path });
    expect(response.status).toBe(401);
    expect(String(response.headers["www-authenticate"])).toMatch(/^Bearer\b/);
    expect(response.body).not.toContain(token);
    expect(response.body).not.toContain("jsonrpc");
    expect(calls).toEqual([]);
  });

test("rejects a foreign Host even with a valid token", async () => {
  const { calls, reader } = spyReader();
  const server = await serve(reader);
  const response = await raw(server.url, {
    headers: {
      host: `attacker.example:${server.url.port}`,
      authorization: `Bearer ${token}`,
    },
  });
  expect(response.status).toBe(403);
  expect(response.body).not.toContain(token);
  expect(calls).toEqual([]);
});

test("rejects paths other than the MCP endpoint even with a valid token", async () => {
  const { calls, reader } = spyReader();
  const server = await serve(reader);
  for (const path of ["/", "/mcp/", "/mcpx", "/health"]) {
    const response = await raw(server.url, {
      path,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  }
  expect(calls).toEqual([]);
});

test("rejections never write the presented credential to diagnostics", async () => {
  const diagnostics = captureDiagnostics("debug");
  const { reader } = spyReader();
  const server = await serve(reader, diagnostics.logger);
  await raw(server.url, { headers: { authorization: `Bearer ${token}x` } });
  await raw(server.url, {
    headers: { host: "attacker.example", authorization: `Bearer ${token}` },
  });
  await server.stop();
  servers.length = 0;
  const records = await diagnostics.finish();
  expect(JSON.stringify(records)).not.toContain(token);
  expect(JSON.stringify(records)).not.toContain("attacker.example");
});

test("refuses to start without a strong token", async () => {
  const { calls, reader } = spyReader();
  for (const weak of ["", " ", "short", "x".repeat(31)])
    await expect(
      startHttp(reader, {
        hostname: "127.0.0.1",
        port: 0,
        token: weak,
        allowedHosts: ["127.0.0.1"],
        logger: captureDiagnostics().logger,
      }),
    ).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("refuses to start without an allowed Host", async () => {
  const { reader } = spyReader();
  await expect(
    startHttp(reader, {
      hostname: "127.0.0.1",
      port: 0,
      token,
      allowedHosts: [],
      logger: captureDiagnostics().logger,
    }),
  ).rejects.toThrow();
});

test("duplicate allowed Hosts collapse instead of refusing to start", async () => {
  const { calls, reader } = spyReader();
  const server = await startHttp(reader, {
    hostname: "127.0.0.1",
    port: 0,
    token,
    allowedHosts: ["127.0.0.1", "127.0.0.1", "localhost", "LOCALHOST"],
    logger: captureDiagnostics().logger,
  });
  servers.push(server);
  await rpc(server.url, token, "tools/call", {
    name: "youtube_get_watch_later",
    arguments: { limit: 1 },
  });
  expect(calls).toEqual(["youtube_get_watch_later"]);
});
