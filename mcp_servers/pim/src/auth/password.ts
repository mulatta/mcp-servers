import { SafeError } from "../errors.ts";
import type { Logger } from "../observability/logger.ts";

/**
 * Basic credentials for one account: the login name and a password issued
 * for this server alone, so its owner can revoke it without touching the
 * account's other clients.
 */
export class Password {
  private header: string;
  private rejected = false;
  private logger: Logger | undefined;

  constructor(
    username: string,
    password: string,
    options: { logger?: Logger | undefined } = {},
  ) {
    this.header = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    this.logger = options.logger;
  }

  /** The Authorization header, or AUTH_REQUIRED once the password was refused. */
  authorization(): string {
    if (this.rejected) throw new SafeError("AUTH_REQUIRED");
    return this.header;
  }

  /**
   * Records that the server refused the password. It is not sent again:
   * Stalwart bans an address after repeated failed sign-ins, and a new
   * password only arrives with a restart.
   */
  reject() {
    if (!this.rejected) this.logger?.emit({ event: "auth.rejected" });
    this.rejected = true;
  }
}
