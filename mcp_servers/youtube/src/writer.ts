import type { SessionProvider } from "./auth/session.ts";
import { SafeError } from "./errors.ts";
import { userPlaylistId, type WriteToolName } from "./tools.ts";
import type { Attempt, Route, YoutubeClient } from "./youtube/client.ts";
import { normalize } from "./youtube/normalize.ts";

export type WriteInput = Record<string, unknown>;
export type Writer = (
  name: WriteToolName,
  input: WriteInput,
  signal: AbortSignal,
  attempt: Attempt,
) => Promise<Record<string, unknown>>;

/**
 * A write that left the process and was not refused with a client error may
 * have been applied, so any later failure is reported as unknown.
 */
export function settle(error: unknown, attempt: Attempt): unknown {
  return attempt.dispatched && !attempt.rejected
    ? new SafeError("WRITE_OUTCOME_UNKNOWN")
    : error;
}

type Operation = {
  routes: Route[];
  path: string;
  // Reads needed before the write, such as entry set IDs; runs with browse only.
  prepare?: (
    client: YoutubeClient,
    input: WriteInput,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  body: (
    input: WriteInput,
    prepared: Record<string, unknown>,
  ) => Record<string, unknown>;
  result: (
    data: Record<string, unknown>,
    input: WriteInput,
  ) => Record<string, unknown>;
};

function edit(action: string, field: string): Operation {
  return {
    ...edited(),
    body: (input) => ({
      playlistId: input.playlist_id,
      actions: (input.video_ids as string[]).map((id) => ({
        action,
        [field]: id,
      })),
    }),
    result: (data, input) => {
      succeeded(data);
      return { playlist_id: input.playlist_id, video_ids: input.video_ids };
    },
  };
}

const operations: Record<WriteToolName, Operation> = {
  youtube_create_playlist: {
    routes: ["create_playlist"],
    path: "/playlist/create",
    body: (input) => ({
      title: input.title,
      privacyStatus: input.privacy,
      videoIds: [],
      ...(input.description ? { description: input.description } : {}),
    }),
    result: (data) => {
      // The playlist exists if the request went through; without its ID we cannot say which.
      if (
        typeof data.playlistId !== "string" ||
        !userPlaylistId.test(data.playlistId)
      )
        throw new SafeError("WRITE_OUTCOME_UNKNOWN");
      return { playlist_id: data.playlistId };
    },
  },
  // YouTube.js 18.3.0 DeletePlaylistEndpoint drops the ID from its request body,
  // so the route is called directly with the body YouTube expects.
  youtube_delete_playlist: {
    routes: ["delete_playlist"],
    path: "/playlist/delete",
    body: (input) => ({ playlistId: input.playlist_id }),
    result: (_data, input) => ({ playlist_id: input.playlist_id }),
  },
  youtube_add_to_playlist: edit("ACTION_ADD_VIDEO", "addedVideoId"),
  // Removing by video ID needs no prior read of the playlist, unlike
  // YouTube.js removeVideos(), which pages through it for set-video IDs.
  youtube_remove_from_playlist: edit(
    "ACTION_REMOVE_VIDEO_BY_VIDEO_ID",
    "removedVideoId",
  ),
  // YouTube.js sends ratings as the TV client with a bare target string; the
  // session here is WEB, so the web body `{ target: { videoId } }` is used.
  youtube_like_video: rate("like", "/like/like", "LIKE", "like"),
  youtube_remove_rating: rate(
    "remove_like",
    "/like/removelike",
    "INDIFFERENT",
    "none",
  ),
  youtube_subscribe: subscription(
    "subscribe",
    "/subscription/subscribe",
    "EgIIAhgA",
    true,
  ),
  youtube_unsubscribe: subscription(
    "unsubscribe",
    "/subscription/unsubscribe",
    "CgIIAhgA",
    false,
  ),
  // Unlike YouTube.js setNotificationPreferences(), which encodes its own
  // protobuf params, the params come from the channel's own bell dropdown.
  youtube_set_channel_notifications: {
    routes: ["channel_notifications"],
    path: "/notification/modify_channel_preference",
    prepare: (client, input, signal) =>
      bellParams(
        client,
        input.channel_id as string,
        input.setting as Bell,
        signal,
      ),
    body: (_input, prepared) => ({ params: prepared.params }),
    result: (data, input) => {
      const updates = (data.frameworkUpdates ?? {}) as Record<string, unknown>;
      const batch = (updates.entityBatchUpdate ?? {}) as Record<
        string,
        unknown
      >;
      const mutations = Array.isArray(batch.mutations) ? batch.mutations : [];
      const confirmed = mutations.some((mutation) => {
        const payload = (mutation as { payload?: Record<string, unknown> })
          .payload;
        const entity = payload?.subscriptionNotificationStateEntity as
          Record<string, unknown> | undefined;
        return entity?.state === bellStates[input.setting as Bell];
      });
      if (!confirmed) throw new SafeError("WRITE_OUTCOME_UNKNOWN");
      return { channel_id: input.channel_id, notification: input.setting };
    },
  },
  // YouTube.js 18.3.0 setName() sends `playlist_id` instead of `playlistId`,
  // so the edit body is built here for both fields.
  youtube_update_playlist: {
    ...edited(),
    body: (input) => ({
      playlistId: input.playlist_id,
      actions: [
        ...(input.title === undefined
          ? []
          : [
              { action: "ACTION_SET_PLAYLIST_NAME", playlistName: input.title },
            ]),
        ...(input.description === undefined
          ? []
          : [
              {
                action: "ACTION_SET_PLAYLIST_DESCRIPTION",
                playlistDescription: input.description,
              },
            ]),
        ...(input.privacy === undefined
          ? []
          : [
              {
                action: "ACTION_SET_PLAYLIST_PRIVACY",
                playlistPrivacy: input.privacy,
              },
            ]),
      ],
    }),
    result: (data, input) => {
      succeeded(data);
      return { playlist_id: input.playlist_id };
    },
  },
  youtube_move_in_playlist: {
    ...edited(),
    prepare: (client, input, signal) =>
      locate(
        client,
        input.playlist_id as string,
        [input.video_id as string, input.after_video_id as string],
        signal,
      ),
    body: (input, prepared) => ({
      playlistId: input.playlist_id,
      actions: [
        {
          action: "ACTION_MOVE_VIDEO_AFTER",
          setVideoId: prepared[input.video_id as string],
          movedSetVideoIdPredecessor: prepared[input.after_video_id as string],
        },
      ],
    }),
    result: (data, input) => {
      succeeded(data);
      return {
        playlist_id: input.playlist_id,
        video_id: input.video_id,
        after_video_id: input.after_video_id,
      };
    },
  },
};

// YouTube answers a rating with the video's new likeStatusEntity.
function rate(
  route: Route,
  path: string,
  expected: "LIKE" | "INDIFFERENT",
  rating: "like" | "none",
): Operation {
  return {
    routes: [route],
    path,
    body: (input) => ({ target: { videoId: input.video_id } }),
    result: (data, input) => {
      const updates = (data.frameworkUpdates ?? {}) as Record<string, unknown>;
      const batch = (updates.entityBatchUpdate ?? {}) as Record<
        string,
        unknown
      >;
      const mutations = Array.isArray(batch.mutations) ? batch.mutations : [];
      const confirmed = mutations.some((mutation) => {
        const payload = (mutation as { payload?: Record<string, unknown> })
          .payload;
        const entity = payload?.likeStatusEntity as
          Record<string, unknown> | undefined;
        return entity?.likeStatus === expected;
      });
      if (!confirmed) throw new SafeError("WRITE_OUTCOME_UNKNOWN");
      return { video_id: input.video_id, rating };
    },
  };
}

// Params are the fixed values YouTube.js 18.3.0 sends for these endpoints.
function subscription(
  route: Route,
  path: string,
  params: string,
  subscribed: boolean,
): Operation {
  return {
    routes: [route],
    path,
    body: (input) => ({ channelIds: [input.channel_id], params }),
    result: (data, input) => {
      const actions = Array.isArray(data.actions) ? data.actions : [];
      const confirmed = actions.some((action) => {
        const update = (action as Record<string, unknown>)
          .updateSubscribeButtonAction as Record<string, unknown> | undefined;
        return (
          update?.channelId === input.channel_id &&
          update?.subscribed === subscribed
        );
      });
      if (!confirmed) throw new SafeError("WRITE_OUTCOME_UNKNOWN");
      return { channel_id: input.channel_id, subscribed };
    },
  };
}

const bellIcons = {
  all: "NOTIFICATIONS_ACTIVE",
  personalized: "NOTIFICATIONS_NONE",
  none: "NOTIFICATIONS_OFF",
} as const;
const bellStates = {
  all: "SUBSCRIPTION_NOTIFICATION_STATE_ALL",
  personalized: "SUBSCRIPTION_NOTIFICATION_STATE_OCCASIONAL",
  none: "SUBSCRIPTION_NOTIFICATION_STATE_OFF",
} as const;
type Bell = keyof typeof bellIcons;
// YouTube caps subscriptions at 2,000; this covers them with room to spare.
const subscriptionPages = 30;

/**
 * Reads the subscription list for the channel's bell dropdown and returns the
 * params YouTube itself offers for the wanted setting, so nothing is encoded here.
 */
async function bellParams(
  client: YoutubeClient,
  channel: string,
  bell: Bell,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  let continuation: string | null = null;
  for (let page = 0; page < subscriptionPages; page++) {
    const token: string | null = continuation;
    const response: { data: unknown } = await client.use(signal, (yt) =>
      yt.actions.execute(
        "/browse",
        token
          ? { continuation: token, parse: false }
          : { browseId: "FEchannels", parse: false },
      ),
    );
    const renderer = findChannel(response.data, channel);
    if (renderer) {
      const params = menuParams(renderer, bellIcons[bell]);
      if (!params) throw new SafeError("UPSTREAM_CHANGED");
      return { params };
    }
    continuation = normalize(response.data, "channels", {
      continuation: !!token,
    }).continuation;
    if (!continuation) throw new SafeError("CHANNEL_NOT_SUBSCRIBED");
  }
  throw new SafeError("UPSTREAM_CHANGED");
}

function findChannel(
  value: unknown,
  channel: string,
  depth = 0,
): Record<string, unknown> | undefined {
  if (depth > 32 || typeof value !== "object" || value === null) return;
  const renderer = (value as Record<string, unknown>).channelRenderer as
    Record<string, unknown> | undefined;
  if (renderer?.channelId === channel) return renderer;
  for (const child of Object.values(value)) {
    const found = findChannel(child, channel, depth + 1);
    if (found) return found;
  }
}

// Exactly one dropdown item may carry the wanted icon and an endpoint.
function menuParams(renderer: unknown, icon: string): string | undefined {
  const found: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 40 || typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "menuServiceItemRenderer") {
        const item = child as {
          icon?: { iconType?: unknown };
          serviceEndpoint?: {
            modifyChannelNotificationPreferenceEndpoint?: { params?: unknown };
          };
        };
        const params =
          item.serviceEndpoint?.modifyChannelNotificationPreferenceEndpoint
            ?.params;
        if (
          item.icon?.iconType === icon &&
          typeof params === "string" &&
          params
        )
          found.push(params);
      }
      visit(child, depth + 1);
    }
  };
  visit(renderer, 0);
  return found.length === 1 ? found[0] : undefined;
}

function succeeded(data: Record<string, unknown>) {
  if (data.status !== "STATUS_SUCCEEDED")
    throw new SafeError("WRITE_OUTCOME_UNKNOWN");
}

function edited(): Pick<Operation, "routes" | "path"> {
  return { routes: ["edit_playlist"], path: "/browse/edit_playlist" };
}

const lookupPages = 60;

/**
 * Maps each wanted video to its playlist entry (set) ID. The whole playlist
 * must be read, because a duplicate further down would make the move ambiguous.
 */
async function locate(
  client: YoutubeClient,
  playlist: string,
  wanted: string[],
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const sets = new Map<string, string[]>();
  const listed = new Map<string, number>();
  let continuation: string | null = null;
  for (let page = 0; page < lookupPages; page++) {
    const token: string | null = continuation;
    const response = await client.use(signal, (yt) =>
      yt.actions.execute(
        "/browse",
        token
          ? { continuation: token, parse: false }
          : { browseId: `VL${playlist}`, parse: false },
      ),
    );
    const parsed = normalize(response.data, "videos", {
      continuation: !!token,
    });
    for (const item of parsed.items)
      if ("video_id" in item && item.video_id)
        listed.set(item.video_id, (listed.get(item.video_id) ?? 0) + 1);
    collectSets(response.data, sets);
    continuation = parsed.continuation;
    if (!continuation) break;
  }
  if (continuation) throw new SafeError("PLAYLIST_TOO_LONG");
  const found: Record<string, string> = {};
  for (const video of wanted) {
    const count = listed.get(video) ?? 0;
    if (count === 0) throw new SafeError("PLAYLIST_ITEM_NOT_FOUND");
    if (count > 1) throw new SafeError("PLAYLIST_ITEM_AMBIGUOUS");
    // An entry shown without a set ID (for example as a lockup) cannot be moved.
    const ids = sets.get(video) ?? [];
    if (ids.length !== 1) throw new SafeError("UPSTREAM_CHANGED");
    found[video] = ids[0]!;
  }
  return found;
}

function collectSets(value: unknown, sets: Map<string, string[]>, depth = 0) {
  if (depth > 32 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSets(item, sets, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  const entry = node.playlistVideoRenderer as
    Record<string, unknown> | undefined;
  if (
    entry &&
    typeof entry.videoId === "string" &&
    typeof entry.setVideoId === "string" &&
    entry.setVideoId
  )
    sets.set(entry.videoId, [
      ...(sets.get(entry.videoId) ?? []),
      entry.setVideoId,
    ]);
  for (const child of Object.values(node)) collectSets(child, sets, depth + 1);
}

export function createWriter(sessions: SessionProvider<YoutubeClient>): Writer {
  return (name, input, signal, attempt) =>
    sessions.once(signal, async (snapshot) => {
      const operation = operations[name];
      const prepared = operation.prepare
        ? await operation.prepare(snapshot.value, input, signal)
        : {};
      const response = await snapshot.value.use(
        signal,
        (client) =>
          client.actions.execute(operation.path, {
            ...operation.body(input, prepared),
            parse: false,
          }),
        operation.routes,
        attempt,
      );
      const data =
        typeof response.data === "object" && response.data !== null
          ? (response.data as Record<string, unknown>)
          : {};
      return {
        account_id: snapshot.accountId,
        ...operation.result(data, input),
      };
    });
}
