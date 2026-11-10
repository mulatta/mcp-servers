import type { ServerWebSocket } from "bun";

export const cookie = (overrides: Record<string, unknown> = {}) => ({
  name: "SAPISID",
  value: "fixture-secret",
  domain: ".youtube.com",
  path: "/",
  secure: true,
  httpOnly: true,
  expires: -1,
  ...overrides,
});

export function cdpFixture(
  options: {
    cookies?: unknown[];
    authority?: string;
    redirect?: boolean;
    noPage?: boolean;
    stall?: boolean;
    delayMs?: number;
    closeEarly?: boolean;
    malformed?: boolean;
  } = {},
) {
  const commands: {
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let discoveries = 0;
  let forbidden = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/json/version") {
        discoveries++;
        if (options.redirect)
          return Response.redirect("http://127.0.0.1:1/secret");
        return Response.json({
          webSocketDebuggerUrl: `ws://${options.authority ?? url.host}/devtools/browser/fixture-secret`,
        });
      }
      if (server.upgrade(req)) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
        const msg = JSON.parse(String(raw));
        commands.push(msg);
        if (options.closeEarly) return ws.close();
        if (options.stall) return;
        if (options.delayMs) await Bun.sleep(options.delayMs);
        if (ws.readyState !== 1) return;
        const results: Record<string, unknown> = {
          "Target.getBrowserContexts": { browserContextIds: ["incognito"] },
          "Target.getTargets": {
            targetInfos: options.noPage
              ? []
              : [
                  {
                    targetId: "private",
                    type: "page",
                    browserContextId: "incognito",
                    url: "https://www.youtube.com/",
                  },
                  {
                    targetId: "default",
                    type: "page",
                    url: "https://www.youtube.com/",
                  },
                ],
          },
          "Target.attachToTarget": { sessionId: "session" },
          "Network.getCookies": { cookies: options.cookies ?? [cookie()] },
          "Target.detachFromTarget": {},
        };
        if (!(msg.method in results)) forbidden = true;
        ws.send(
          options.malformed
            ? "not-json"
            : JSON.stringify({ id: msg.id, result: results[msg.method] }),
        );
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    commands,
    get connections() {
      return sockets.size;
    },
    get discoveries() {
      return discoveries;
    },
    get forbidden() {
      return forbidden;
    },
    close() {
      for (const ws of sockets) ws.close();
      server.stop(true);
    },
  };
}
