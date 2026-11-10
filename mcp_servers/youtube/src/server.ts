import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, SafeError } from "./errors.ts";
import { withDeadline } from "./deadline.ts";
import { withRequest } from "./observability/trace.ts";
import type { Logger } from "./observability/logger.ts";

import {
  detailToolNames,
  toolNames,
  userPlaylistId,
  writeToolGroups,
  writeToolNames,
  type ReadToolName,
  type ToolName,
  type WriteToolName,
} from "./tools.ts";
import type { WriteGroup } from "./config.ts";
import { settle, type Writer } from "./writer.ts";
import type { Attempt } from "./youtube/client.ts";

export { readToolNames, toolNames, type ToolName } from "./tools.ts";
export interface ReadInput {
  limit: number;
  cursor?: string | undefined;
  playlist_id?: string | undefined;
  channel_id?: string | undefined;
}
export type Reader = (
  name: ReadToolName,
  input: ReadInput,
  signal: AbortSignal,
) => Promise<Record<string, unknown>>;
const descriptions: Record<ToolName, string> = {
  youtube_list_playlists: "List the authenticated account's playlists.",
  youtube_get_playlist:
    "Read a playlist by ID, including private playlists accessible to this account.",
  youtube_get_watch_later: "Read the authenticated account's Watch Later list.",
  youtube_get_liked_videos: "Read the authenticated account's liked videos.",
  youtube_get_watch_history: "Read the authenticated account's watch history.",
  youtube_list_subscriptions:
    "List the channels the authenticated account subscribes to, with each channel's notification setting.",
  youtube_get_channel_videos:
    "Read a channel's uploads, newest first, by channel ID.",
};

// Hermes forwards only tool descriptions and error messages to its model, so
// every caveat a caller needs is in the descriptions; instructions repeat the
// whole flow for clients that read them.
const staleCursor =
  "A cursor from before a write returns pre-write results; start without a cursor to see changes.";
export const instructions = [
  "This server reads and changes one YouTube account.",
  "Writes are sent once and never retried.",
  "After a write, lists show the change only after a delay (playlists a few seconds, Watch Later up to ~20 s, likes and subscriptions ~6 s); re-read without an old cursor and retry the read, not the write.",
  "WRITE_OUTCOME_UNKNOWN means the write may have happened: read the target first, because repeating a create or add makes duplicates.",
  "Removing a video removes all its entries in that playlist.",
  "Moves need the video that should precede; they cannot move to the top.",
  "Notification bells exist only for subscribed channels.",
  "Use video and channel IDs from read results, never from URLs.",
].join(" ");

export function createServer(
  reader: Reader = async () => {
    throw new SafeError("UPSTREAM_UNAVAILABLE");
  },
  options: {
    timeoutMs?: number | undefined;
    logger?: Logger | undefined;
    writer?: Writer | undefined;
    writes?: ReadonlySet<WriteGroup> | undefined;
  } = {},
) {
  const server = new McpServer(
    { name: "youtube-mcp", version: "0.0.0" },
    { instructions },
  );
  const paging = {
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(256).optional(),
  };
  const targets: Partial<Record<ToolName, z.ZodRawShape>> = {
    youtube_get_playlist: {
      playlist_id: z.string().regex(/^[A-Za-z0-9_-]{2,150}$/),
    },
    youtube_get_channel_videos: {
      channel_id: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
    },
  };
  for (const name of toolNames) {
    const inputSchema = z.strictObject({ ...paging, ...targets[name] });
    server.registerTool(
      name,
      {
        description: `${descriptions[name]} ${staleCursor}`,
        inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        try {
          const result = await withRequest(
            options.logger,
            name,
            input.limit,
            () =>
              withDeadline(
                extra.signal,
                options.timeoutMs ?? 30_000,
                (signal) => reader(name, input, signal),
              ),
          );
          return {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  }
  for (const name of detailToolNames)
    server.registerTool(
      name,
      {
        description:
          "Read a playlist's title, description and privacy by playlist ID.",
        inputSchema: z.strictObject({
          playlist_id: z.string().regex(/^[A-Za-z0-9_-]{2,150}$/),
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (input, extra) => {
        try {
          const result = await withRequest(
            options.logger,
            name,
            undefined,
            () =>
              withDeadline(
                extra.signal,
                options.timeoutMs ?? 30_000,
                (signal) => reader(name, { limit: 1, ...input }, signal),
              ),
          );
          return {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );
  const writer = options.writer;
  if (writer)
    for (const name of writeToolNames) {
      if (!options.writes?.has(writeToolGroups[name])) continue;
      const definition = writeTools[name];
      server.registerTool(
        name,
        {
          description: definition.description,
          inputSchema: z
            .strictObject(definition.input)
            .refine(definition.check ?? (() => true)),
          annotations: {
            readOnlyHint: false,
            destructiveHint: definition.destructive,
            idempotentHint: false,
            openWorldHint: true,
          },
        },
        async (input, extra) => {
          const attempt: Attempt = { dispatched: false, rejected: false };
          try {
            const result = await withRequest(
              options.logger,
              name,
              undefined,
              () =>
                withDeadline(
                  extra.signal,
                  options.timeoutMs ?? 30_000,
                  (signal) => writer(name, input, signal, attempt),
                ),
            ).catch((error: unknown) => {
              throw settle(error, attempt);
            });
            return {
              structuredContent: result,
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (error) {
            return errorResult(error);
          }
        },
      );
    }
  return server;
}

// Liked videos (LL) change through ratings, and mixes or uploads are not editable.
const editablePlaylist = z
  .string()
  .refine((id) => id === "WL" || userPlaylistId.test(id));
// A repeated ID would add the video twice, which is rarely what a caller meant.
const videoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const channelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const videoBatch = z
  .array(videoId)
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);
const writeTools: Record<
  WriteToolName,
  {
    description: string;
    input: z.ZodRawShape;
    destructive: boolean;
    check?: (input: Record<string, unknown>) => boolean;
  }
> = {
  youtube_create_playlist: {
    description:
      "Create an empty playlist on the authenticated account. Private unless privacy is given. Not idempotent: on WRITE_OUTCOME_UNKNOWN, list playlists before retrying, or a second playlist is created. A new playlist appears in reads after a few seconds.",
    input: {
      title: z.string().min(1).max(150),
      privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).default("PRIVATE"),
      description: z.string().max(5000).optional(),
    },
    destructive: false,
  },
  youtube_delete_playlist: {
    description:
      "Delete one of the authenticated account's playlists by its PL playlist ID. Permanent: it cannot be restored.",
    input: { playlist_id: z.string().regex(userPlaylistId) },
    destructive: true,
  },
  youtube_add_to_playlist: {
    description:
      "Add up to 50 videos to one of the account's playlists or to Watch Later (WL). Appends even if a video is already listed, creating a duplicate entry; on WRITE_OUTCOME_UNKNOWN read the playlist before retrying. Watch Later reads lag up to ~20 s.",
    input: { playlist_id: editablePlaylist, video_ids: videoBatch },
    destructive: false,
  },
  youtube_remove_from_playlist: {
    description:
      "Remove up to 50 videos from one of the account's playlists or from Watch Later (WL). Removes every entry of each video, including duplicates. Watch Later reads lag up to ~20 s.",
    input: { playlist_id: editablePlaylist, video_ids: videoBatch },
    destructive: true,
  },
  youtube_update_playlist: {
    description:
      "Change the title and/or description of one of the account's PL playlists. Title and description only; privacy cannot be changed.",
    input: {
      playlist_id: z.string().regex(userPlaylistId),
      title: z.string().min(1).max(150).optional(),
      description: z.string().max(5000).optional(),
    },
    destructive: false,
    check: (input) =>
      input.title !== undefined || input.description !== undefined,
  },
  youtube_move_in_playlist: {
    description:
      "Move a video in a PL playlist or Watch Later (WL) so it sits directly after after_video_id; moving to the top is not possible. Fails without changing anything if either video is missing or listed twice, or the playlist exceeds ~6000 entries.",
    input: {
      playlist_id: editablePlaylist,
      video_id: videoId,
      after_video_id: videoId,
    },
    destructive: false,
    check: (input) => input.video_id !== input.after_video_id,
  },
  youtube_like_video: {
    description:
      "Like a video on the authenticated account. Sets the rating; repeating is harmless. Liked videos update after a few seconds.",
    input: { video_id: videoId },
    destructive: false,
  },
  youtube_remove_rating: {
    description:
      "Remove the authenticated account's like or dislike from a video. Sets the rating; repeating is harmless. Liked videos update after a few seconds.",
    input: { video_id: videoId },
    destructive: true,
  },
  youtube_subscribe: {
    description:
      "Subscribe the authenticated account to a channel by UC ID. The subscription list updates after ~6 s.",
    input: { channel_id: channelId },
    destructive: false,
  },
  youtube_unsubscribe: {
    description:
      "Unsubscribe the authenticated account from a channel by UC ID. The subscription list updates after ~6 s.",
    input: { channel_id: channelId },
    destructive: true,
  },
  youtube_set_channel_notifications: {
    description:
      "Set the notification bell of a channel the account subscribes to: all, personalized or none. Other channels fail with CHANNEL_NOT_SUBSCRIBED; subscribe first.",
    input: {
      channel_id: channelId,
      setting: z.enum(["all", "personalized", "none"]),
    },
    destructive: false,
  },
};
