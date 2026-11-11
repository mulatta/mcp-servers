// A stand-in for the Stalwart HTTP listener: the OAuth device and token
// endpoints, the JMAP session and the JMAP API, with the response shapes of
// Stalwart 0.15. Every value is synthetic.

export type MethodCall = [string, Record<string, unknown>, string];
export type JmapHandler = (
  calls: MethodCall[],
  using: string[],
) => MethodCall[] | Response | Promise<MethodCall[] | Response>;

export interface FakeStalwart {
  origin: string;
  /** Refresh tokens the server accepts. */
  refreshTokens: Set<string>;
  /** Access tokens the server accepts. */
  accessTokens: Set<string>;
  /** Device codes and how many more polls stay pending before approval. */
  devices: Map<string, { pending: number; clientId: string }>;
  /** Hands out a new refresh token on the next refresh grant. */
  rotateNext: boolean;
  /** Answer for the next token request, instead of the normal flow. */
  tokenOverride?: Response | undefined;
  tokenRequests: URLSearchParams[];
  jmapRequests: { calls: MethodCall[]; using: string[]; token: string }[];
  sessionRequests: number;
  jmap: JmapHandler;
  stop(): Promise<void>;
}

export const accountId = "a1";
export const username = "tester@example.test";

let serial = 0;
const issue = (prefix: string) => `${prefix}-${++serial}-synthetic`;

function oauthError(error: string) {
  return Response.json({ error }, { status: 400 });
}

export function session(origin: string) {
  const capabilities = {
    "urn:ietf:params:jmap:core": {
      maxSizeUpload: 50_000_000,
      maxConcurrentUpload: 4,
      maxSizeRequest: 10_000_000,
      maxConcurrentRequests: 4,
      maxCallsInRequest: 16,
      maxObjectsInGet: 500,
      maxObjectsInSet: 500,
      collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap"],
    },
    "urn:ietf:params:jmap:mail": {},
    "urn:ietf:params:jmap:submission": {},
    "urn:ietf:params:jmap:vacationresponse": {},
    "urn:ietf:params:jmap:sieve": {},
    "urn:ietf:params:jmap:calendars": {},
    "urn:ietf:params:jmap:contacts": {},
  };
  return {
    capabilities,
    accounts: {
      [accountId]: {
        name: username,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: Object.fromEntries(
          Object.keys(capabilities).map((key) => [key, {}]),
        ),
      },
    },
    primaryAccounts: Object.fromEntries(
      Object.keys(capabilities).map((key) => [key, accountId]),
    ),
    username,
    apiUrl: `${origin}/jmap/`,
    downloadUrl: `${origin}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${origin}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${origin}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: "s1",
  };
}

export function startStalwart(): FakeStalwart {
  const fake: Omit<FakeStalwart, "origin" | "stop"> = {
    refreshTokens: new Set(),
    accessTokens: new Set(),
    devices: new Map(),
    rotateNext: false,
    tokenRequests: [],
    jmapRequests: [],
    sessionRequests: 0,
    jmap: () => new Response(null, { status: 500 }),
  };
  const grant = (withRefresh: boolean) => {
    const access = issue("access");
    fake.accessTokens.add(access);
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: "bearer",
      expires_in: 3600,
    };
    if (withRefresh) {
      const refresh = issue("refresh");
      fake.refreshTokens.add(refresh);
      body.refresh_token = refresh;
    }
    return Response.json(body);
  };
  const bearer = (request: Request) => {
    const match = /^Bearer (.+)$/.exec(
      request.headers.get("authorization") ?? "",
    );
    return match && fake.accessTokens.has(match[1]!) ? match[1]! : undefined;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/auth/device" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        const clientId = form.get("client_id");
        if (!clientId) return new Response(null, { status: 400 });
        const deviceCode = issue("device");
        fake.devices.set(deviceCode, { pending: 1, clientId });
        return Response.json({
          verification_uri: `${origin}/authorize`,
          verification_uri_complete: `${origin}/authorize/?code=ABCD-EFGH`,
          device_code: deviceCode,
          user_code: "ABCD-EFGH",
          expires_in: 1800,
          interval: 5,
        });
      }
      if (url.pathname === "/auth/token" && request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        fake.tokenRequests.push(form);
        if (fake.tokenOverride) {
          const answer = fake.tokenOverride;
          fake.tokenOverride = undefined;
          return answer;
        }
        const type = form.get("grant_type");
        if (type === "urn:ietf:params:oauth:grant-type:device_code") {
          const device = fake.devices.get(form.get("device_code") ?? "");
          if (!device) return oauthError("expired_token");
          if (device.clientId !== form.get("client_id"))
            return oauthError("invalid_client");
          if (device.pending-- > 0) return oauthError("authorization_pending");
          fake.devices.delete(form.get("device_code")!);
          return grant(true);
        }
        if (type === "refresh_token") {
          if (!fake.refreshTokens.has(form.get("refresh_token") ?? ""))
            return oauthError("invalid_grant");
          const rotate = fake.rotateNext;
          fake.rotateNext = false;
          return grant(rotate);
        }
        return oauthError("invalid_grant");
      }
      if (url.pathname === "/jmap/session" && request.method === "GET") {
        fake.sessionRequests++;
        if (!bearer(request)) return new Response(null, { status: 401 });
        return Response.json(session(origin));
      }
      if (url.pathname === "/jmap/" && request.method === "POST") {
        const token = bearer(request);
        if (!token) return new Response(null, { status: 401 });
        const body = (await request.json()) as {
          using: string[];
          methodCalls: MethodCall[];
        };
        fake.jmapRequests.push({
          calls: body.methodCalls,
          using: body.using,
          token,
        });
        const answer = await fake.jmap(body.methodCalls, body.using);
        if (answer instanceof Response) return answer;
        return Response.json({ methodResponses: answer, sessionState: "s1" });
      }
      return new Response(null, { status: 404 });
    },
  });
  const origin: string = `http://127.0.0.1:${server.port}`;
  return Object.assign(fake, {
    origin,
    async stop() {
      await server.stop(true);
    },
  });
}
