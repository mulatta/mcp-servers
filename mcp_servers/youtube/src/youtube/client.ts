import { AsyncLocalStorage } from "node:async_hooks";
import { Innertube, Log, YTNodes } from "youtubei.js";
import { SafeError } from "../errors.ts";
import { normalize, type Page } from "./normalize.ts";
import { checkResponse } from "./response.ts";
import type { ToolName, ReadInput } from "../server.ts";

Log.setLevel(Log.Level.NONE);

export type Network = (request: Request) => Promise<Response>;
const activeSignal = new AsyncLocalStorage<AbortSignal>();

export class YoutubeClient {
  private constructor(private client: Innertube) {}

  static async connect(
    cookie: string,
    signal: AbortSignal,
    network: Network = (request) => fetch(request),
  ) {
    const client = await activeSignal.run(signal, () =>
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
            const signal = activeSignal.getStore();
            if (!signal) throw new SafeError("UPSTREAM_UNAVAILABLE");
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
              url.pathname !== "/youtubei/v1/browse"
            )
              throw new SafeError("UPSTREAM_UNAVAILABLE");
            let response: Response;
            try {
              response = await network(request);
            } catch {
              throw new SafeError("UPSTREAM_UNAVAILABLE");
            }
            await checkResponse(response);
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
      const page = await client.actions.execute("/browse", {
        browseId: "SPaccount_advanced",
        parse: true,
      });
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
              : `VL${input.playlist_id}`;
    return this.use(signal, async (client) => {
      const response = await client.actions.execute(
        "/browse",
        continuation
          ? { continuation, parse: false }
          : { browseId, parse: false },
      );
      return normalize(
        response.data,
        name === "youtube_list_playlists"
          ? "playlists"
          : name === "youtube_get_watch_history"
            ? "history"
            : "videos",
      );
    });
  }

  async use<T>(
    signal: AbortSignal,
    operation: (client: Innertube) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    try {
      return await activeSignal.run(signal, () => operation(this.client));
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError("UPSTREAM_CHANGED");
    }
  }
}
