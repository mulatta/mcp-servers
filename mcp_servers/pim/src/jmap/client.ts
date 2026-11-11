import { z } from "zod";
import type { ServerConfig } from "../config.ts";
import { SafeError, type ErrorCode } from "../errors.ts";
import type { Credentials } from "../auth/tokens.ts";
import type { Logger } from "../observability/logger.ts";

export const using = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  vacation: "urn:ietf:params:jmap:vacationresponse",
  sieve: "urn:ietf:params:jmap:sieve",
  calendars: "urn:ietf:params:jmap:calendars",
  contacts: "urn:ietf:params:jmap:contacts",
  blob: "urn:ietf:params:jmap:blob",
} as const;
export type Capability = Exclude<keyof typeof using, "core">;

/** Tracks whether a write left this process, so failures after it read as unknown. */
export interface Attempt {
  dispatched: boolean;
}

export type Args = Record<string, unknown>;
export type Call = [method: string, args: Args];

const sessionSchema = z.object({
  apiUrl: z.string(),
  primaryAccounts: z.record(z.string(), z.string()),
  username: z.string(),
  state: z.string().optional(),
});
const responseSchema = z.object({
  methodResponses: z.array(
    z.tuple([z.string(), z.record(z.string(), z.unknown()), z.string()]),
  ),
  sessionState: z.string().optional(),
});

// RFC 8620 method-level errors. A method error means that call changed
// nothing, except serverFail, whose effect is not specified.
const methodErrors: Record<string, ErrorCode> = {
  invalidArguments: "INVALID_REQUEST",
  invalidResultReference: "UPSTREAM_CHANGED",
  unknownMethod: "UPSTREAM_CHANGED",
  unsupportedFilter: "INVALID_REQUEST",
  unsupportedSort: "INVALID_REQUEST",
  requestTooLarge: "INVALID_REQUEST",
  tooManyChanges: "INVALID_REQUEST",
  fromAccountNotFound: "NOT_FOUND",
  accountNotFound: "UPSTREAM_CHANGED",
  accountNotSupportedByMethod: "UPSTREAM_CHANGED",
  accountReadOnly: "WRITE_REJECTED",
  forbidden: "WRITE_REJECTED",
  stateMismatch: "WRITE_REJECTED",
  anchorNotFound: "CURSOR_INVALID",
  cannotCalculateChanges: "CURSOR_INVALID",
  serverFail: "UPSTREAM_UNAVAILABLE",
  serverUnavailable: "UPSTREAM_UNAVAILABLE",
  serverPartialFail: "UPSTREAM_UNAVAILABLE",
};

interface Session {
  apiUrl: string;
  accountId: string;
  username: string;
}

/**
 * JMAP over HTTP for the signed-in account. The bearer token goes only to the
 * configured origin: a session naming an API elsewhere is refused.
 */
export class Jmap {
  private session: Promise<Session> | undefined;
  /** State of the cached session; a response naming another drops the cache. */
  private sessionState: string | undefined;
  private fetch: typeof fetch;
  private logger: Logger | undefined;

  constructor(
    private config: ServerConfig,
    private credentials: Credentials,
    options: { fetch?: typeof fetch; logger?: Logger | undefined } = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.logger = options.logger;
  }

  /** The signed-in account's login name, for checks that pin an account. */
  async username(signal: AbortSignal) {
    return (await this.currentSession(signal)).username;
  }

  /**
   * Sends calls in one request and returns each call's arguments, in call
   * order. Call IDs are c0, c1, ... so later calls can reference earlier
   * results. With `attempt`, the request is a write: it is never sent twice,
   * except after a 401, which Stalwart answers before running anything.
   */
  async call(
    capabilities: Capability[],
    calls: Call[],
    signal: AbortSignal,
    options: { attempt?: Attempt } = {},
  ): Promise<Args[]> {
    const write = options.attempt;
    for (let tries = 0; ; tries++) {
      const token = await this.credentials.accessToken(signal);
      const session = await this.currentSession(signal, token);
      const body = JSON.stringify({
        using: [using.core, ...capabilities.map((name) => using[name])],
        methodCalls: calls.map(([method, args], index) => [
          method,
          { accountId: session.accountId, ...args },
          `c${index}`,
        ]),
      });
      if (write) write.dispatched = true;
      let response: Response;
      try {
        response = await this.fetch(session.apiUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body,
          redirect: "error",
          signal,
        });
      } catch {
        throw this.failed(calls, write, "UPSTREAM_UNAVAILABLE");
      }
      if (response.status === 401) {
        if (write) write.dispatched = false;
        this.credentials.invalidate(token);
        this.session = undefined;
        if (tries > 0) throw new SafeError("AUTH_REQUIRED");
        await this.credentials.refresh("unauthorized");
        continue;
      }
      if (response.status === 429) {
        this.record(calls, write, false, response.status);
        throw new SafeError("RATE_LIMITED");
      }
      // Request-level problems (RFC 8620 3.6.1) are refused before any method runs.
      if (response.status === 400 && !write)
        throw new SafeError("UPSTREAM_CHANGED");
      if (!response.ok)
        throw this.failed(
          calls,
          write,
          "UPSTREAM_UNAVAILABLE",
          response.status,
        );
      const parsed = responseSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!parsed.success)
        throw this.failed(calls, write, "UPSTREAM_CHANGED", response.status);
      this.record(calls, write, true, response.status);
      if (
        parsed.data.sessionState &&
        parsed.data.sessionState !== this.sessionState
      )
        this.session = undefined;
      return this.results(calls, parsed.data.methodResponses, write);
    }
  }

  private results(
    calls: Call[],
    responses: [string, Args, string][],
    write: Attempt | undefined,
  ): Args[] {
    return calls.map((_call, index) => {
      // A method may answer with several responses; the first one with the
      // call's ID and name, or an error, is the answer.
      const answer = responses.find(([, , id]) => id === `c${index}`);
      if (!answer) throw this.failed(calls, write, "UPSTREAM_CHANGED");
      const [name, args] = answer;
      if (name === "error") {
        const type = typeof args.type === "string" ? args.type : "";
        if (type === "serverFail" && write)
          throw new SafeError("WRITE_OUTCOME_UNKNOWN");
        throw new SafeError(methodErrors[type] ?? "UPSTREAM_CHANGED");
      }
      return args;
    });
  }

  private failed(
    calls: Call[],
    write: Attempt | undefined,
    code: ErrorCode,
    status?: number,
  ) {
    if (!write) return new SafeError(code);
    this.record(calls, write, false, status);
    return new SafeError(write.dispatched ? "WRITE_OUTCOME_UNKNOWN" : code);
  }

  private record(
    calls: Call[],
    write: Attempt | undefined,
    confirmed: boolean,
    status?: number,
  ) {
    if (!write) return;
    this.logger?.emit({
      event: "upstream.write",
      methods: calls.map(([method]) => method),
      confirmed,
      ...(status === undefined ? {} : { http_status: status }),
    });
  }

  private currentSession(
    signal: AbortSignal,
    token?: string,
  ): Promise<Session> {
    this.session ??= this.fetchSession(signal, token).catch((error) => {
      this.session = undefined;
      throw error;
    });
    return this.session;
  }

  private async fetchSession(
    signal: AbortSignal,
    given?: string,
  ): Promise<Session> {
    for (let tries = 0; ; tries++) {
      const token = given ?? (await this.credentials.accessToken(signal));
      given = undefined;
      const response = await this.fetch(`${this.config.origin}/jmap/session`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal,
      }).catch(() => {
        throw new SafeError("UPSTREAM_UNAVAILABLE");
      });
      if (response.status === 401) {
        this.credentials.invalidate(token);
        if (tries > 0) throw new SafeError("AUTH_REQUIRED");
        await this.credentials.refresh("unauthorized");
        continue;
      }
      if (response.status === 429) throw new SafeError("RATE_LIMITED");
      if (!response.ok) throw new SafeError("UPSTREAM_UNAVAILABLE");
      const parsed = sessionSchema.safeParse(
        await response.json().catch(() => undefined),
      );
      if (!parsed.success) throw new SafeError("UPSTREAM_CHANGED");
      const { apiUrl, primaryAccounts, username, state } = parsed.data;
      let api: URL;
      try {
        api = new URL(apiUrl);
      } catch {
        throw new SafeError("UPSTREAM_CHANGED");
      }
      if (api.origin !== this.config.origin)
        throw new SafeError("UPSTREAM_CHANGED");
      const accountId = primaryAccounts[using.mail];
      if (!accountId) throw new SafeError("UPSTREAM_CHANGED");
      this.sessionState = state;
      return { apiUrl: api.href, accountId, username };
    }
  }
}
