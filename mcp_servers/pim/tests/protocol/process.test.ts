import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validDiagnostic } from "../../src/observability/logger.ts";
import {
  password,
  startStalwart,
  username,
  type FakeStalwart,
} from "../fixtures/stalwart.ts";

const entry = new URL("../../src/index.ts", import.meta.url).pathname;
let dir: string;
let stalwart: FakeStalwart;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pim-process-"));
  stalwart = startStalwart();
  stalwart.passwords.add(`${username}:${password}`);
  await writeFile(join(dir, "password"), `${password}\n`);
  stalwart.jmap = (calls) =>
    calls.map(([name, , id]) => [
      name,
      {
        list: [
          {
            id: "m1",
            name: "Inbox",
            parentId: null,
            role: "inbox",
            totalEmails: 1,
            unreadEmails: 0,
          },
        ],
      },
      id,
    ]);
});
afterEach(async () => {
  await stalwart.stop();
  await rm(dir, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "",
  PIM_SERVER_URL: stalwart.origin,
  PIM_USERNAME: username,
  PIM_PASSWORD_FILE: join(dir, "password"),
  PIM_LOG_LEVEL: "debug",
  ...extra,
});

function checkDiagnostics(stderr: string) {
  const lines = stderr.split("\n").filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines)
    expect(validDiagnostic(JSON.parse(line))).toBe(true);
  for (const secret of [password, "Inbox"])
    expect(stderr).not.toContain(secret);
  return lines.map((line) => JSON.parse(line));
}

test("stdio serves tools and logs only safe fields", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: env({ PIM_WRITES: "draft" }),
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "process", version: "0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toContain("pim_list_mailboxes");
  const result = await client.callTool({
    name: "pim_list_mailboxes",
    arguments: {},
  });
  expect(result.isError).toBeFalsy();
  await client.close();
  await Bun.sleep(50);
  const records = checkDiagnostics(stderr);
  expect(records).toContainEqual(
    expect.objectContaining({ event: "server.start", writes: ["draft"] }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      event: "request.end",
      tool: "pim_list_mailboxes",
      outcome: "ok",
      returned_count: 1,
    }),
  );
});

test("invalid configuration exits before serving", async () => {
  for (const [extra, code] of [
    [{ PIM_SERVER_URL: "http://mail.example.test" }, "INVALID_SERVER"],
    [{ PIM_WRITES: "everything" }, "INVALID_WRITES"],
    [{ PIM_PASSWORD_FILE: join(dir, "missing") }, "INVALID_ACCOUNT"],
    [
      {
        PIM_TRANSPORT: "http",
        PIM_HTTP_PORT: "1",
        PIM_HTTP_TOKEN_FILE: join(dir, "missing"),
      },
      "INVALID_HTTP_CONFIG",
    ],
  ] as const) {
    const child = Bun.spawn([process.execPath, entry], {
      env: env(extra),
      stdin: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const records = checkDiagnostics(await new Response(child.stderr).text());
    expect(records).toContainEqual(
      expect.objectContaining({ event: "config.invalid", code }),
    );
  }
});

test("HTTP checks host, token, path and method in that order", async () => {
  const token = `${"t".repeat(32)}${crypto.randomUUID()}`;
  await writeFile(join(dir, "http-token"), `${token}\n`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn([process.execPath, entry], {
    env: env({
      PIM_TRANSPORT: "http",
      PIM_HTTP_PORT: String(port),
      PIM_HTTP_TOKEN_FILE: join(dir, "http-token"),
    }),
    stderr: "pipe",
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    let response: Response | undefined;
    for (let i = 0; i < 100 && !response; i++)
      response = await fetch(`${url}/mcp`, {
        method: "POST",
        body,
        headers,
      }).catch(async () => {
        await Bun.sleep(50);
        return undefined;
      });
    expect(response!.status).toBe(401);
    // A rebinding page must not learn whether a token is accepted.
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host: "evil.example.test",
            authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    expect(foreign).toBe(403);
    const auth = { ...headers, authorization: `Bearer ${token}` };
    expect(
      (await fetch(`${url}/other`, { method: "POST", body, headers: auth }))
        .status,
    ).toBe(404);
    expect(
      (await fetch(`${url}/mcp`, { method: "GET", headers: auth })).status,
    ).toBe(405);
    const ok = await fetch(`${url}/mcp`, {
      method: "POST",
      body,
      headers: auth,
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("connection")).toBe("close");
    expect(JSON.stringify(await ok.json())).toContain("pim_list_mailboxes");
  } finally {
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  }
  checkDiagnostics(await new Response(child.stderr).text());
});
