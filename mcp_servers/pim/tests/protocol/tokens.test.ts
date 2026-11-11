import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Credentials,
  TokenStore,
  type StoredToken,
} from "../../src/auth/tokens.ts";
import { SafeError } from "../../src/errors.ts";
import { startStalwart, type FakeStalwart } from "../fixtures/stalwart.ts";
import { captureLogs } from "../fixtures/log.ts";

let dir: string;
let stalwart: FakeStalwart;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pim-tokens-"));
  stalwart = startStalwart();
});
afterEach(async () => {
  await stalwart.stop();
  await rm(dir, { recursive: true, force: true });
});

const stored = (refresh: string, origin = stalwart.origin): StoredToken => ({
  version: 1,
  origin,
  client_id: "pim-mcp",
  refresh_token: refresh,
});
const config = () => ({
  origin: stalwart.origin,
  clientId: "pim-mcp",
  stateDir: dir,
});
const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "none",
    (error) => (error instanceof SafeError ? error.code : String(error)),
  );
const signal = () => new AbortController().signal;
const refreshRequests = () =>
  stalwart.tokenRequests.filter(
    (form) => form.get("grant_type") === "refresh_token",
  );

describe("token file", () => {
  test("is written with owner-only permissions and no leftovers", async () => {
    const store = new TokenStore(join(dir, "state"));
    await store.save(stored("r-1"));
    expect(await store.load()).toEqual(stored("r-1"));
    expect((await stat(join(dir, "state"))).mode & 0o777).toBe(0o700);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, "state"))).toEqual(["token.json"]);
  });

  test("a save interrupted before the rename keeps the old token", async () => {
    await new TokenStore(dir).save(stored("old"));
    const crashing = new TokenStore(dir, {
      beforeRename: () => {
        throw new Error("killed");
      },
    });
    await expect(crashing.save(stored("new"))).rejects.toThrow();
    expect((await new TokenStore(dir).load())?.refresh_token).toBe("old");
  });

  test("a save interrupted after the rename keeps the new token", async () => {
    await new TokenStore(dir).save(stored("old"));
    const crashing = new TokenStore(dir, {
      afterRename: () => {
        throw new Error("killed");
      },
    });
    await expect(crashing.save(stored("new"))).rejects.toThrow();
    expect((await new TokenStore(dir).load())?.refresh_token).toBe("new");
  });

  test("temporary files left by a killed process are ignored", async () => {
    await new TokenStore(dir).save(stored("old"));
    await writeFile(join(dir, ".token.json.123.tmp"), "{partial");
    expect((await new TokenStore(dir).load())?.refresh_token).toBe("old");
  });

  test("a missing or malformed file reads as signed out", async () => {
    expect(await new TokenStore(dir).load()).toBeUndefined();
    await writeFile(join(dir, "token.json"), "{not json");
    expect(await new TokenStore(dir).load()).toBeUndefined();
  });
});

describe("credentials", () => {
  test("without a token file every call needs a login, without contacting the server", async () => {
    const credentials = new Credentials(config(), new TokenStore(dir));
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "AUTH_REQUIRED",
    );
    expect(stalwart.tokenRequests).toHaveLength(0);
  });

  test("a token for another server or client is not used", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1", "https://other.example.test"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "AUTH_REQUIRED",
    );
    expect(stalwart.tokenRequests).toHaveLength(0);
  });

  test("an access token is reused until a minute before it expires", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    let now = 1_000_000;
    const credentials = new Credentials(config(), new TokenStore(dir), {
      now: () => now,
    });
    const first = await credentials.accessToken(signal());
    expect(stalwart.accessTokens.has(first)).toBe(true);
    now += 3_539_000;
    expect(await credentials.accessToken(signal())).toBe(first);
    now += 2_000;
    expect(await credentials.accessToken(signal())).not.toBe(first);
    expect(refreshRequests()).toHaveLength(2);
    expect(refreshRequests()[0]!.get("refresh_token")).toBe("r-1");
    expect(refreshRequests()[0]!.get("client_id")).toBe("pim-mcp");
  });

  test("concurrent request and background refreshes send one refresh", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    const tokens = await Promise.all([
      credentials.refresh("background"),
      ...Array.from({ length: 5 }, () => credentials.accessToken(signal())),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(refreshRequests()).toHaveLength(1);
  });

  test("a caller that gives up does not cancel the shared refresh", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    const controller = new AbortController();
    const abandoned = credentials.accessToken(controller.signal);
    controller.abort();
    expect(await codeOf(abandoned)).toBe("UPSTREAM_UNAVAILABLE");
    expect(
      stalwart.accessTokens.has(await credentials.accessToken(signal())),
    ).toBe(true);
    expect(refreshRequests()).toHaveLength(1);
  });

  test("a rotated refresh token replaces the file", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    stalwart.rotateNext = true;
    const { logger, records, flush } = captureLogs();
    const credentials = new Credentials(config(), new TokenStore(dir), {
      logger,
    });
    await credentials.refresh("background");
    const saved = JSON.parse(await readFile(join(dir, "token.json"), "utf8"));
    expect(saved.refresh_token).not.toBe("r-1");
    expect(stalwart.refreshTokens.has(saved.refresh_token)).toBe(true);
    await flush();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "auth.refresh",
        trigger: "background",
        outcome: "ok",
        rotated: true,
      }),
    );
    expect(JSON.stringify(records)).not.toContain(saved.refresh_token);
  });

  test("a failed save keeps working and is logged with a fixed code", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    stalwart.rotateNext = true;
    const { logger, records, flush } = captureLogs();
    let full = true;
    const failing = new TokenStore(dir, {
      beforeRename: () => {
        if (full) throw new Error("disk full");
      },
    });
    const credentials = new Credentials(config(), failing, { logger });
    expect(
      stalwart.accessTokens.has(await credentials.refresh("background")),
    ).toBe(true);
    await flush();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "state.write_failed",
        code: "STATE_WRITE_FAILED",
      }),
    );
    // The file still holds the old token, which Stalwart keeps accepting.
    expect((await new TokenStore(dir).load())?.refresh_token).toBe("r-1");
    // The next refresh sends the new token from memory.
    const rotated = [...stalwart.refreshTokens].find(
      (token) => token !== "r-1",
    )!;
    await credentials.refresh("background");
    expect(refreshRequests().at(-1)!.get("refresh_token")).toBe(rotated);
    // Once the disk recovers, the next refresh saves it even without a rotation.
    full = false;
    await credentials.refresh("background");
    expect((await new TokenStore(dir).load())?.refresh_token).toBe(rotated);
  });

  test("a revoked token needs a login, and a new login is picked up without a restart", async () => {
    await new TokenStore(dir).save(stored("revoked"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "AUTH_REQUIRED",
    );
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "AUTH_REQUIRED",
    );
    expect(refreshRequests()).toHaveLength(2);
    stalwart.refreshTokens.add("r-2");
    await new TokenStore(dir).save(stored("r-2"));
    expect(
      stalwart.accessTokens.has(await credentials.accessToken(signal())),
    ).toBe(true);
  });

  test("server failures keep the token", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    stalwart.tokenOverride = new Response(null, { status: 503 });
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "UPSTREAM_UNAVAILABLE",
    );
    stalwart.tokenOverride = new Response(null, { status: 429 });
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "RATE_LIMITED",
    );
    stalwart.tokenOverride = Response.json({ unexpected: true });
    expect(await codeOf(credentials.accessToken(signal()))).toBe(
      "UPSTREAM_CHANGED",
    );
    expect(
      stalwart.accessTokens.has(await credentials.accessToken(signal())),
    ).toBe(true);
    expect((await new TokenStore(dir).load())?.refresh_token).toBe("r-1");
  });

  test("a rejected access token is dropped so the next call refreshes", async () => {
    stalwart.refreshTokens.add("r-1");
    await new TokenStore(dir).save(stored("r-1"));
    const credentials = new Credentials(config(), new TokenStore(dir));
    const first = await credentials.accessToken(signal());
    credentials.invalidate(first);
    const second = await credentials.accessToken(signal());
    expect(second).not.toBe(first);
    expect(refreshRequests()).toHaveLength(2);
  });
});
