import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials, TokenStore } from "../../src/auth/tokens.ts";
import { Jmap } from "../../src/jmap/client.ts";
import type { Logger } from "../../src/observability/logger.ts";
import { startStalwart, type FakeStalwart } from "./stalwart.ts";

/** A fake Stalwart and a signed-in JMAP client for it. */
export async function signedIn(options: { logger?: Logger } = {}) {
  const stalwart = startStalwart();
  const dir = await mkdtemp(join(tmpdir(), "pim-"));
  const config = {
    origin: stalwart.origin,
    clientId: "pim-mcp",
    stateDir: dir,
  };
  stalwart.refreshTokens.add("refresh-synthetic");
  const store = new TokenStore(dir);
  await store.save({
    version: 1,
    origin: stalwart.origin,
    client_id: "pim-mcp",
    refresh_token: "refresh-synthetic",
  });
  const credentials = new Credentials(config, store, options);
  const jmap = new Jmap(config, credentials, options);
  return {
    stalwart,
    credentials,
    jmap,
    config,
    async stop() {
      await stalwart.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export type SignedIn = Awaited<ReturnType<typeof signedIn>> & {
  stalwart: FakeStalwart;
};
