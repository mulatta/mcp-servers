import type { SessionProvider } from "./auth/session.ts";
import { SafeError } from "./errors.ts";
import { userPlaylistId, type WriteToolName } from "./tools.ts";
import type { Attempt, Route, YoutubeClient } from "./youtube/client.ts";

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
  body: (input: WriteInput) => Record<string, unknown>;
  result: (
    data: Record<string, unknown>,
    input: WriteInput,
  ) => Record<string, unknown>;
};

function edit(action: string, field: string): Operation {
  return {
    routes: ["edit_playlist"],
    path: "/browse/edit_playlist",
    body: (input) => ({
      playlistId: input.playlist_id,
      actions: (input.video_ids as string[]).map((id) => ({
        action,
        [field]: id,
      })),
    }),
    result: (data, input) => {
      if (data.status !== "STATUS_SUCCEEDED")
        throw new SafeError("WRITE_OUTCOME_UNKNOWN");
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
};

export function createWriter(sessions: SessionProvider<YoutubeClient>): Writer {
  return (name, input, signal, attempt) =>
    sessions.once(signal, async (snapshot) => {
      const operation = operations[name];
      const response = await snapshot.value.use(
        signal,
        (client) =>
          client.actions.execute(operation.path, {
            ...operation.body(input),
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
