import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../config.ts";
import { SafeError } from "../errors.ts";
import type { Logger } from "../observability/logger.ts";

const storedToken = z.strictObject({
  version: z.literal(1),
  origin: z.string(),
  client_id: z.string(),
  refresh_token: z.string().min(1),
});
export type StoredToken = z.infer<typeof storedToken>;

/** Points at which a test can stop a save, as a killed process would. */
export interface SaveHooks {
  beforeRename?: () => void;
  afterRename?: () => void;
}

/**
 * The refresh token on disk. A save writes a temporary file in the same
 * directory, flushes it, renames it over token.json and flushes the
 * directory, so a process killed at any point leaves either the old or the
 * new token in place, never a partial file.
 */
export class TokenStore {
  readonly path: string;
  constructor(
    readonly dir: string,
    private hooks: SaveHooks = {},
  ) {
    this.path = join(dir, "token.json");
  }

  async load(): Promise<StoredToken | undefined> {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = storedToken.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return;
    }
  }

  async save(token: StoredToken): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temporary = join(this.dir, `.token.json.${crypto.randomUUID()}.tmp`);
    let renamed = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(token) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      this.hooks.beforeRename?.();
      await rename(temporary, this.path);
      renamed = true;
      this.hooks.afterRename?.();
      const directory = await open(this.dir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      if (!renamed) await unlink(temporary).catch(() => {});
    }
  }
}

const grant = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});
const oauthError = z.object({ error: z.string() });
// Errors meaning the refresh token itself is no good: only a new login helps.
const signedOut = new Set([
  "invalid_grant",
  "expired_token",
  "invalid_client",
  "access_denied",
]);

export type RefreshTrigger = "request" | "background" | "unauthorized";

/**
 * Access tokens for the JMAP API. Access tokens live only in memory; the
 * refresh token is read from the token file and replaced there when Stalwart
 * rotates it. All refreshes, whether a request found the access token
 * expired or the daily background timer fired, share one request in flight.
 */
export class Credentials {
  private access: { token: string; expiresAt: number } | undefined;
  private refreshToken: string | undefined;
  /** A rotated refresh token that could not be written yet. */
  private unsaved = false;
  private inflight: Promise<string> | undefined;
  private now: () => number;
  private logger: Logger | undefined;
  private fetch: typeof fetch;

  constructor(
    private config: ServerConfig,
    private store: TokenStore,
    options: {
      now?: () => number;
      logger?: Logger | undefined;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.fetch = options.fetch ?? fetch;
  }

  /** A valid access token, refreshing it a minute before it expires. */
  async accessToken(signal: AbortSignal): Promise<string> {
    if (this.access && this.now() < this.access.expiresAt - 60_000)
      return this.access.token;
    return this.wait(this.refresh("request"), signal);
  }

  /** Forget an access token the server refused, unless already replaced. */
  invalidate(token: string) {
    if (this.access?.token === token) this.access = undefined;
  }

  refresh(trigger: RefreshTrigger): Promise<string> {
    this.inflight ??= this.exchange(trigger).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** Keeps the refresh token alive while idle: Stalwart rotates it only in its last days. */
  startBackground(intervalMs = 24 * 60 * 60 * 1000): () => void {
    const run = () => {
      this.refresh("background").catch(() => {});
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  // The shared refresh must outlive a caller that gives up, so each caller
  // races its own signal instead of aborting the exchange.
  private wait(shared: Promise<string>, signal: AbortSignal) {
    if (signal.aborted)
      return Promise.reject(new SafeError("UPSTREAM_UNAVAILABLE"));
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(new SafeError("UPSTREAM_UNAVAILABLE"));
      signal.addEventListener("abort", abort, { once: true });
      shared.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }

  private async exchange(trigger: RefreshTrigger): Promise<string> {
    const started = performance.now();
    let status: number | undefined;
    let rotated = false;
    try {
      const refreshToken = this.refreshToken ?? (await this.loadRefreshToken());
      const response = await this.fetch(`${this.config.origin}/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.config.clientId,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {
        throw new SafeError("UPSTREAM_UNAVAILABLE");
      });
      status = response.status;
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const error = oauthError.safeParse(body);
        if (
          response.status === 400 &&
          error.success &&
          signedOut.has(error.data.error)
        ) {
          // Read the file again next time: the operator may have logged in anew.
          this.refreshToken = undefined;
          this.access = undefined;
          this.unsaved = false;
          throw new SafeError("AUTH_REQUIRED");
        }
        if (response.status === 429) throw new SafeError("RATE_LIMITED");
        if (response.status >= 500) throw new SafeError("UPSTREAM_UNAVAILABLE");
        throw new SafeError("UPSTREAM_CHANGED");
      }
      const parsed = grant.safeParse(body);
      if (!parsed.success) throw new SafeError("UPSTREAM_CHANGED");
      const { access_token, expires_in, refresh_token } = parsed.data;
      this.access = {
        token: access_token,
        expiresAt: this.now() + expires_in * 1000,
      };
      if (refresh_token && refresh_token !== refreshToken) {
        rotated = true;
        this.refreshToken = refresh_token;
        this.unsaved = true;
      } else this.refreshToken = refreshToken;
      if (this.unsaved) await this.persist(this.refreshToken);
      this.logger?.emit({
        event: "auth.refresh",
        trigger,
        outcome: "ok",
        rotated,
        http_status: status,
        duration_ms: performance.now() - started,
      });
      return access_token;
    } catch (error) {
      const safe =
        error instanceof SafeError
          ? error
          : new SafeError("UPSTREAM_UNAVAILABLE");
      this.logger?.emit({
        event: "auth.refresh",
        trigger,
        outcome: "error",
        code: safe.code,
        http_status: status,
        duration_ms: performance.now() - started,
      });
      throw safe;
    }
  }

  private async loadRefreshToken() {
    const stored = await this.store.load();
    if (
      !stored ||
      stored.origin !== this.config.origin ||
      stored.client_id !== this.config.clientId
    )
      throw new SafeError("AUTH_REQUIRED");
    return stored.refresh_token;
  }

  // Stalwart keeps accepting the previous refresh token until it expires, so a
  // failed save loses nothing yet: the new token stays in memory and every
  // later refresh, including the daily one, tries the save again.
  private async persist(refreshToken: string) {
    try {
      await this.store.save({
        version: 1,
        origin: this.config.origin,
        client_id: this.config.clientId,
        refresh_token: refreshToken,
      });
      this.unsaved = false;
    } catch {
      this.logger?.emit({
        event: "state.write_failed",
        code: "STATE_WRITE_FAILED",
      });
    }
  }
}
