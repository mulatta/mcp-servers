// A stand-in for the Stalwart HTTP listener: Basic authentication, the JMAP
// session and the JMAP API, with the response shapes of Stalwart 0.15. Every
// value is synthetic.

export type MethodCall = [string, Record<string, unknown>, string];
export type JmapHandler = (
  calls: MethodCall[],
  using: string[],
) => MethodCall[] | Response | Promise<MethodCall[] | Response>;

export interface FakeStalwart {
  origin: string;
  /** Login name and password pairs the server accepts, as user:password. */
  passwords: Set<string>;
  /** Requests answered 401. */
  refused: number;
  jmapRequests: { calls: MethodCall[]; using: string[]; user: string }[];
  sessionRequests: number;
  jmap: JmapHandler;
  stop(): Promise<void>;
}

export const accountId = "a1";
export const username = "tester";
export const password = "app-password-synthetic";

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
    passwords: new Set(),
    refused: 0,
    jmapRequests: [],
    sessionRequests: 0,
    jmap: () => new Response(null, { status: 500 }),
  };
  /** The login name of accepted Basic credentials, or undefined. */
  const user = (request: Request) => {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) return undefined;
    const pair = Buffer.from(match[1]!, "base64").toString("utf8");
    return fake.passwords.has(pair) ? pair.split(":")[0] : undefined;
  };
  const refuse = () => {
    fake.refused++;
    return new Response(null, { status: 401 });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/jmap/session" && request.method === "GET") {
        fake.sessionRequests++;
        if (!user(request)) return refuse();
        return Response.json(session(origin));
      }
      if (url.pathname === "/jmap/" && request.method === "POST") {
        const name = user(request);
        if (!name) return refuse();
        const body = (await request.json()) as {
          using: string[];
          methodCalls: MethodCall[];
        };
        fake.jmapRequests.push({
          calls: body.methodCalls,
          using: body.using,
          user: name,
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
