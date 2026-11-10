import { accountPage } from "./account.ts";
import playlists from "./library/playlists.json";
import history from "./library/history.json";
import { cdpFixture, cookie } from "./cdp.ts";
import { SessionProvider } from "../../src/auth/session.ts";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { acquireCookies } from "../../src/auth/cdp.ts";

export function libraryServer(
  options: { pages?: number[]; now?: () => number; cookieValue?: string } = {},
) {
  const browser = cdpFixture({
    cookies: [cookie({ value: options.cookieValue ?? "fixture-secret" })],
  });
  const pages = options.pages ?? [2];
  let accountId = "UCaaaaaaaaaaaaaaaaaaaaaa";
  let authFailures = 0;
  let reads = 0;
  let stall = false;
  let aborted = 0;
  const paths: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      paths.push(new URL(req.url).pathname);
      const body = await req.json();
      if (
        req.method !== "POST" ||
        new URL(req.url).pathname !== "/youtubei/v1/browse"
      )
        return new Response(null, { status: 500 });
      if (body.browseId === "SPaccount_advanced")
        return Response.json(accountPage(accountId));
      reads++;
      if (stall)
        return new Promise<Response>((resolve) => {
          req.signal.addEventListener(
            "abort",
            () => {
              aborted++;
              resolve(new Response(null, { status: 499 }));
            },
            { once: true },
          );
        });
      if (authFailures-- > 0) return new Response(null, { status: 401 });
      if (body.browseId === "FEplaylist_aggregation")
        return Response.json(playlists);
      if (body.browseId === "FEhistory") {
        // The sample's continuation is removed for the finite integration fixture.
        const copy = structuredClone(history);
        const sections =
          copy.contents.twoColumnBrowseResultsRenderer.tabs[0]!.tabRenderer
            .content.sectionListRenderer;
        sections.contents = sections.contents.filter(
          (x) => !("continuationItemRenderer" in x),
        );
        return Response.json(copy);
      }
      const index = body.continuation ? Number(body.continuation) : 0;
      const offset = pages.slice(0, index).reduce((a, b) => a + b, 0);
      const items: unknown[] = Array.from(
        { length: pages[index] ?? 0 },
        (_, i) => ({
          playlistVideoRenderer: {
            videoId: `v${String((offset + i) % 13).padStart(10, "0")}`,
            title: { simpleText: `Fixture ${offset + i}` },
            isPlayable: true,
          },
        }),
      );
      if (index + 1 < pages.length)
        items.push({
          continuationItemRenderer: {
            continuationEndpoint: {
              continuationCommand: { token: String(index + 1) },
            },
          },
        });
      return Response.json(
        body.continuation
          ? {
              onResponseReceivedActions: [
                { appendContinuationItemsAction: { continuationItems: items } },
              ],
            }
          : { contents: { playlistVideoListRenderer: { contents: items } } },
      );
    },
  });
  const network = (request: Request) => {
    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = `127.0.0.1:${upstream.port}`;
    return fetch(new Request(url, request));
  };
  const sessions = new SessionProvider(
    async (signal) =>
      YoutubeClient.connect(
        await acquireCookies(browser.url, signal),
        signal,
        network,
      ),
    options.now,
  );
  return {
    browser,
    upstream,
    sessions,
    network,
    paths,
    get reads() {
      return reads;
    },
    get aborted() {
      return aborted;
    },
    set stall(value: boolean) {
      stall = value;
    },
    set accountId(id: string) {
      accountId = id;
    },
    set authFailures(count: number) {
      authFailures = count;
    },
    close() {
      browser.close();
      upstream.stop(true);
    },
  };
}
