import { z } from "zod";
import { SafeError } from "../errors.ts";
import { readConfig } from "../config.ts";
import { stage } from "../observability/trace.ts";

const target = "https://www.youtube.com/";
const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  partitionKey: z
    .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() })
    .optional(),
  partitionKeyOpaque: z.boolean().optional(),
});

function cookieHeader(raw: unknown): string {
  const { cookies } = z.object({ cookies: z.array(z.unknown()) }).parse(raw);
  const selected = cookies.flatMap((item) => {
    const parsed = cookieSchema.safeParse(item);
    if (!parsed.success) return [];
    const c = parsed.data;
    if (
      ![".youtube.com", ".www.youtube.com", "www.youtube.com"].includes(
        c.domain.toLowerCase(),
      ) ||
      c.path !== "/"
    )
      return [];
    if (c.expires !== -1 && c.expires <= Date.now() / 1000) return [];
    if (
      c.partitionKeyOpaque ||
      (c.partitionKey &&
        (c.partitionKey.topLevelSite !== "https://youtube.com" ||
          c.partitionKey.hasCrossSiteAncestor))
    )
      return [];
    // Reject header injection and ambiguous cookie pairs at the trust boundary.
    if (
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(c.name) ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(c.value)
    )
      return [];
    return [`${c.name}=${c.value}`];
  });
  if (!selected.length) throw new SafeError("AUTH_REQUIRED");
  return selected.join("; ");
}

function socketUrl(raw: string, endpoint: URL): string {
  const url = new URL(raw);
  const protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  if (
    url.protocol !== protocol ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)
  )
    throw new Error();
  // Chromium behind a local tunnel may advertise its own loopback authority.
  const loopbacks = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.host !== endpoint.host &&
    !(loopbacks.has(url.hostname) && loopbacks.has(endpoint.hostname))
  )
    throw new Error();
  url.host = endpoint.host;
  return url.href;
}

class CdpConnection {
  private socket: WebSocket;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  private rejectOpen: (error: unknown) => void = () => {};
  readonly opened: Promise<void>;
  private onAbort = () => this.close();
  constructor(
    url: string,
    private signal: AbortSignal,
  ) {
    this.socket = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.rejectOpen = reject;
      this.socket.addEventListener("open", () => resolve(), { once: true });
    });
    this.socket.addEventListener("error", () => this.close());
    this.socket.addEventListener("close", () => this.close());
    this.socket.addEventListener("message", (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 1024 * 1024)
          throw new Error();
        const message = z
          .object({
            id: z.number().optional(),
            result: z.unknown().optional(),
            error: z.unknown().optional(),
          })
          .parse(JSON.parse(event.data));
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error !== undefined)
          pending.reject(new SafeError("BROWSER_UNAVAILABLE"));
        else pending.resolve(message.result);
      } catch {
        this.close();
      }
    });
    signal.addEventListener("abort", this.onAbort, { once: true });
    if (signal.aborted) this.close();
  }
  async call(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    this.signal.throwIfAborted();
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new SafeError("BROWSER_UNAVAILABLE");
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch {
        this.close();
      }
    });
  }
  close() {
    const error = new SafeError("BROWSER_UNAVAILABLE");
    this.rejectOpen(error);
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    this.signal.removeEventListener("abort", this.onAbort);
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
  }
}

async function cdpStage<T>(
  name: "cdp.connect" | "cdp.cookies",
  operation: () => Promise<T>,
): Promise<T> {
  return stage(name, async () => {
    try {
      return await operation();
    } catch (error) {
      throw error instanceof SafeError
        ? error
        : new SafeError("BROWSER_UNAVAILABLE");
    }
  });
}

export async function acquireCookies(
  endpoint: string,
  signal: AbortSignal,
): Promise<string> {
  let connection: CdpConnection | undefined;
  try {
    signal.throwIfAborted();
    const cdp = await cdpStage("cdp.connect", async () => {
      const url = new URL(readConfig({ YOUTUBE_CDP_URL: endpoint }).cdpUrl);
      const response = await fetch(new URL("/json/version", url), {
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error();
      const discovery = z
        .object({ webSocketDebuggerUrl: z.string() })
        .parse(await response.json());
      connection = new CdpConnection(
        socketUrl(discovery.webSocketDebuggerUrl, url),
        signal,
      );
      await connection.opened;
      return connection;
    });
    return await cdpStage("cdp.cookies", async () => {
      const contexts = z
        .object({ browserContextIds: z.array(z.string()) })
        .parse(await cdp.call("Target.getBrowserContexts"));
      const targets = z
        .object({
          targetInfos: z.array(
            z.object({
              targetId: z.string(),
              type: z.string(),
              browserContextId: z.string().optional(),
            }),
          ),
        })
        .parse(await cdp.call("Target.getTargets"));
      const page = targets.targetInfos.find(
        (t) =>
          t.type === "page" &&
          (!t.browserContextId ||
            !contexts.browserContextIds.includes(t.browserContextId)),
      );
      if (!page) throw new Error();
      const { sessionId } = z.object({ sessionId: z.string() }).parse(
        await cdp.call("Target.attachToTarget", {
          targetId: page.targetId,
          flatten: true,
        }),
      );
      try {
        return cookieHeader(
          await cdp.call("Network.getCookies", { urls: [target] }, sessionId),
        );
      } finally {
        if (!signal.aborted)
          await cdp.call("Target.detachFromTarget", { sessionId });
      }
    });
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("BROWSER_UNAVAILABLE");
  } finally {
    connection?.close();
  }
}
