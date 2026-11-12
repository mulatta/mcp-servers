import { Password } from "../../src/auth/password.ts";
import { Jmap } from "../../src/jmap/client.ts";
import type { Logger } from "../../src/observability/logger.ts";
import {
  password,
  startStalwart,
  username,
  type FakeStalwart,
} from "./stalwart.ts";

/** A fake Stalwart and a JMAP client signed in to it with a password. */
export function signedIn(options: { logger?: Logger } = {}) {
  const stalwart = startStalwart();
  stalwart.passwords.add(`${username}:${password}`);
  const config = { origin: stalwart.origin, username };
  const credentials = new Password(username, password, options);
  const jmap = new Jmap(config, credentials, options);
  return {
    stalwart,
    credentials,
    jmap,
    config,
    stop: () => stalwart.stop(),
  };
}
export type SignedIn = ReturnType<typeof signedIn> & {
  stalwart: FakeStalwart;
};
