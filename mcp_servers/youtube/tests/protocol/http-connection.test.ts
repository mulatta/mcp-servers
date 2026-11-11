import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { startHttp } from "../../src/http.ts";
import type { Reader } from "../../src/server.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";

const token = "a".repeat(32) + crypto.randomUUID().replaceAll("-", "");
const servers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

const reader: Reader = async () => ({
  account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
  items: [],
  next_cursor: null,
  has_more: false,
});

async function serve() {
  const server = await startHttp(reader, {
    hostname: "127.0.0.1",
    port: 0,
    token,
    allowedHosts: ["127.0.0.1"],
    logger: captureDiagnostics().logger,
  });
  servers.push(server);
  return server.url;
}

// A client that leaks half-closed keep-alive sockets exhausted the relay in
// front of the server (observed on citra), so every answer ends its connection.
function exchange(
  url: URL,
  request: {
    method?: string;
    path?: string;
    host?: string;
    auth?: boolean;
    body?: string;
  },
) {
  return new Promise<{ head: string; closedMs: number }>((resolve, reject) => {
    const body = request.body ?? "";
    const socket = connect(Number(url.port), url.hostname);
    const started = performance.now();
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connection stayed open: ${data.split("\r\n")[0]}`));
    }, 3000);
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({
        head: data.split("\r\n\r\n")[0]!.toLowerCase(),
        closedMs: performance.now() - started,
      });
    });
    socket.on("error", reject);
    socket.write(
      [
        `${request.method ?? "POST"} ${request.path ?? "/mcp"} HTTP/1.1`,
        `Host: ${request.host ?? `127.0.0.1:${url.port}`}`,
        "Connection: keep-alive",
        ...(request.auth === false ? [] : [`Authorization: Bearer ${token}`]),
        "Content-Type: application/json",
        "Accept: application/json, text/event-stream",
        "MCP-Protocol-Version: 2025-06-18",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "",
        body,
      ].join("\r\n"),
    );
  });
}

const listTools = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

for (const [label, request, status] of [
  ["a served request", { body: listTools }, "200"],
  ["a foreign Host", { host: "evil.example", body: listTools }, "403"],
  ["a missing token", { auth: false, body: listTools }, "401"],
  ["another path", { path: "/other", body: listTools }, "404"],
  ["another method", { method: "GET" }, "405"],
] as const)
  test(`${label} answers ${status} with Connection: close and closes the socket`, async () => {
    const { head, closedMs } = await exchange(await serve(), request);
    expect(head.split("\r\n")[0]).toContain(` ${status}`);
    expect(head).toContain("connection: close");
    // Far below Bun's idle timeout, so the close comes from the response, not idleness.
    expect(closedMs).toBeLessThan(2000);
  });
