import { z } from "zod";
import type { ServerConfig } from "../config.ts";
import type { TokenStore } from "./tokens.ts";

const deviceAuthorization = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});
const granted = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
});
const oauthError = z.object({ error: z.string() });
const session = z.object({ username: z.string() });

export interface LoginIo {
  /** Shows a line to the operator running the login. */
  print: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
}

/**
 * OAuth 2.0 device authorization (RFC 8628) against Stalwart: the operator
 * opens the shown address, signs in and approves, and the refresh token is
 * written to the token file. The token is never printed.
 */
export async function login(
  config: ServerConfig,
  store: TokenStore,
  io: LoginIo,
): Promise<void> {
  const send = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms) => Bun.sleep(ms));
  const post = (path: string, form: Record<string, string>) =>
    send(`${config.origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

  const started = await post("/auth/device", { client_id: config.clientId });
  if (!started.ok)
    throw new Error(`Device authorization failed with HTTP ${started.status}.`);
  const device = deviceAuthorization.parse(await started.json());
  io.print(
    `Open ${device.verification_uri_complete ?? device.verification_uri} and approve code ${device.user_code}.`,
  );
  io.print("Waiting for approval...");

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("The device code expired.");
    await sleep(interval);
    const response = await post("/auth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: config.clientId,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const tokens = granted.parse(body);
      await store.save({
        version: 1,
        origin: config.origin,
        client_id: config.clientId,
        refresh_token: tokens.refresh_token,
      });
      io.print(`Signed in as ${await account(tokens.access_token)}.`);
      io.print(`Token saved to ${store.path}.`);
      return;
    }
    const error = oauthError.safeParse(body);
    if (!error.success)
      throw new Error(`Token request failed with HTTP ${response.status}.`);
    if (error.data.error === "authorization_pending") continue;
    if (error.data.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`Login failed: ${error.data.error}.`);
  }

  async function account(accessToken: string) {
    const response = await send(`${config.origin}/jmap/session`, {
      headers: { authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const parsed = session.safeParse(
      await response.json().catch(() => undefined),
    );
    return parsed.success ? parsed.data.username : "an unknown account";
  }
}
