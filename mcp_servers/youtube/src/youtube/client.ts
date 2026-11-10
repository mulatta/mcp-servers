import { AsyncLocalStorage } from "node:async_hooks";
import { Innertube, Log, YTNodes } from "youtubei.js";
import { SafeError } from "../errors.ts";
import {
  channelVideosParams,
  normalize,
  playlistDetails,
  type Page,
} from "./normalize.ts";
import { checkResponse } from "./response.ts";
import { stage } from "../observability/trace.ts";
import type { ToolName, ReadInput } from "../server.ts";

Log.setLevel(Log.Level.NONE);

export type Network = (request: Request) => Promise<Response>;

// Every authenticated request must name its route; nothing else leaves with cookies.
const routes = {
  browse: "/youtubei/v1/browse",
  edit_playlist: "/youtubei/v1/browse/edit_playlist",
  create_playlist: "/youtubei/v1/playlist/create",
  delete_playlist: "/youtubei/v1/playlist/delete",
  like: "/youtubei/v1/like/like",
  remove_like: "/youtubei/v1/like/removelike",
  subscribe: "/youtubei/v1/subscription/subscribe",
  unsubscribe: "/youtubei/v1/subscription/unsubscribe",
  channel_notifications: "/youtubei/v1/notification/modify_channel_preference",
} as const;
export type Route = keyof typeof routes;

// Tracks whether a write left the process and whether YouTube refused it outright.
export type Attempt = { dispatched: boolean; rejected: boolean };

const active = new AsyncLocalStorage<{
  signal: AbortSignal;
  paths: ReadonlySet<string>;
  attempt: Attempt | undefined;
}>();
const scope = (
  signal: AbortSignal,
  granted: readonly Route[],
  attempt?: Attempt,
) => ({
  signal,
  paths: new Set(granted.map((route) => routes[route])),
  attempt,
});

export class YoutubeClient {
  private constructor(private client: Innertube) {}

  static async connect(
    cookie: string,
    signal: AbortSignal,
    network: Network = (request) => fetch(request),
  ) {
    return stage("auth.identity", async () => {
      const client = await active.run(scope(signal, ["browse"]), () =>
        Innertube.create({
          cookie,
          account_index: 0,
          retrieve_player: false,
          enable_session_cache: false,
          generate_session_locally: true,
          retrieve_innertube_config: false,
          lang: "en",
          location: "US",
          fetch: Object.assign(
            async (input: RequestInfo | URL, init?: RequestInit) => {
              const current = active.getStore();
              if (!current) throw new SafeError("UPSTREAM_UNAVAILABLE");
              const { signal, paths, attempt } = current;
              signal.throwIfAborted();
              const request = new Request(input, {
                ...init,
                signal,
                redirect: "error",
              });
              const url = new URL(request.url);
              if (
                url.origin !== "https://www.youtube.com" ||
                request.method !== "POST" ||
                !paths.has(url.pathname)
              )
                throw new SafeError("UPSTREAM_UNAVAILABLE");
              const writing = attempt && url.pathname !== routes.browse;
              if (writing) attempt.dispatched = true;
              let response: Response;
              try {
                response = await network(request);
              } catch {
                throw new SafeError("UPSTREAM_UNAVAILABLE");
              }
              try {
                await checkResponse(response);
              } catch (error) {
                // Only a client-error status proves the write was refused, not applied.
                if (writing && response.status >= 400 && response.status < 500)
                  attempt.rejected = true;
                throw error;
              }
              return response;
            },
            {
              preconnect() {
                throw new SafeError("UPSTREAM_UNAVAILABLE");
              },
            },
          ),
        }),
      );
      const value = new YoutubeClient(client);
      const accountId = await value.use(signal, async (client) => {
        // A fixed account settings read provides channel identity, not a name or handle.
        const page = await stage("upstream.request", () =>
          client.actions.execute("/browse", {
            browseId: "SPaccount_advanced",
            parse: true,
          }),
        );
        const ids = new Set(
          page.contents_memo
            ?.getType(YTNodes.CopyLink)
            .map((link) => link.short_url)
            .filter((id) => /^UC[A-Za-z0-9_-]{22}$/.test(id)),
        );
        if (ids.size !== 1) throw new SafeError("AUTH_REQUIRED");
        return [...ids][0]!;
      });
      return { accountId, value };
    });
  }

  async page(
    name: ToolName,
    input: ReadInput,
    signal: AbortSignal,
    continuation?: string,
  ): Promise<Page> {
    const browseId =
      name === "youtube_list_playlists"
        ? "FEplaylist_aggregation"
        : name === "youtube_get_watch_history"
          ? "FEhistory"
          : name === "youtube_get_watch_later"
            ? "VLWL"
            : name === "youtube_get_liked_videos"
              ? "VLLL"
              : name === "youtube_list_subscriptions"
                ? "FEchannels"
                : name === "youtube_get_channel_videos"
                  ? input.channel_id
                  : `VL${input.playlist_id}`;
    // Selects the Videos tab, newest first, without first loading the channel home.
    const params =
      name === "youtube_get_channel_videos"
        ? { params: channelVideosParams }
        : {};
    return this.use(signal, async (client) => {
      const response = await stage("upstream.request", () =>
        client.actions.execute(
          "/browse",
          continuation
            ? { continuation, parse: false }
            : { browseId, ...params, parse: false },
        ),
      );
      return stage("normalize", () =>
        normalize(
          response.data,
          name === "youtube_list_playlists"
            ? "playlists"
            : name === "youtube_get_watch_history"
              ? "history"
              : name === "youtube_list_subscriptions"
                ? "channels"
                : name === "youtube_get_channel_videos"
                  ? "channel_videos"
                  : "videos",
          { continuation: !!continuation },
        ),
      );
    });
  }

  async details(playlistId: string, signal: AbortSignal) {
    return this.use(signal, async (client) => {
      const response = await stage("upstream.request", () =>
        client.actions.execute("/browse", {
          browseId: `VL${playlistId}`,
          parse: false,
        }),
      );
      return stage("normalize", () => playlistDetails(response.data));
    });
  }

  async use<T>(
    signal: AbortSignal,
    operation: (client: Innertube) => Promise<T>,
    granted: readonly Route[] = ["browse"],
    attempt?: Attempt,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      return await active.run(scope(signal, granted, attempt), () =>
        operation(this.client),
      );
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError("UPSTREAM_CHANGED");
    }
  }
}
