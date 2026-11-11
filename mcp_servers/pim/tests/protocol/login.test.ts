import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../../src/auth/login.ts";
import { TokenStore } from "../../src/auth/tokens.ts";
import {
  startStalwart,
  username,
  type FakeStalwart,
} from "../fixtures/stalwart.ts";

let dir: string;
let stalwart: FakeStalwart;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pim-login-"));
  stalwart = startStalwart();
});
afterEach(async () => {
  await stalwart.stop();
  await rm(dir, { recursive: true, force: true });
});

const run = (lines: string[], sleeps: number[] = []) =>
  login(
    { origin: stalwart.origin, clientId: "pim-mcp", stateDir: dir },
    new TokenStore(dir),
    {
      print: (line) => lines.push(line),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

test("device flow stores the refresh token and names the account", async () => {
  const lines: string[] = [];
  const sleeps: number[] = [];
  await run(lines, sleeps);
  const output = lines.join("\n");
  expect(output).toContain(`${stalwart.origin}/authorize/?code=ABCD-EFGH`);
  expect(output).toContain("ABCD-EFGH");
  expect(output).toContain(username);
  // One pending poll, then the approval, each after the server's interval.
  expect(sleeps).toEqual([5000, 5000]);
  const stored = await new TokenStore(dir).load();
  expect(stored?.origin).toBe(stalwart.origin);
  expect(stored?.client_id).toBe("pim-mcp");
  expect(stalwart.refreshTokens.has(stored!.refresh_token)).toBe(true);
  expect(output).not.toContain(stored!.refresh_token);
  const device = stalwart.tokenRequests[0]!;
  expect(device.get("client_id")).toBe("pim-mcp");
});

test("slow_down widens the polling interval", async () => {
  const sleeps: number[] = [];
  stalwart.tokenOverride = Response.json(
    { error: "slow_down" },
    { status: 400 },
  );
  await run([], sleeps);
  expect(sleeps).toEqual([5000, 10000, 10000]);
});

test("a denied or expired request fails without writing a token", async () => {
  stalwart.tokenOverride = Response.json(
    { error: "expired_token" },
    { status: 400 },
  );
  await expect(run([])).rejects.toThrow(/expired_token/);
  expect(await new TokenStore(dir).load()).toBeUndefined();
});
