import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, SafeError } from "./errors.ts";
import { withDeadline } from "./deadline.ts";
import { withRequest } from "./observability/trace.ts";
import type { Logger } from "./observability/logger.ts";

import {
  toolNames,
  userPlaylistId,
  writeToolGroups,
  writeToolNames,
  type ToolName,
  type WriteToolName,
} from "./tools.ts";
import type { WriteGroup } from "./config.ts";
import { settle, type Writer } from "./writer.ts";
import type { Attempt } from "./youtube/client.ts";

export { toolNames, type ToolName };
export interface ReadInput {
  limit: number;
  cursor?: string | undefined;
  playlist_id?: string | undefined;
  channel_id?: string | undefined;
}
export type Reader = (
  name: ToolName,
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
  const server = new McpServer({ name: "youtube-mcp", version: "0.0.0" });
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
        description: descriptions[name],
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
      "Create an empty playlist on the authenticated account. Private unless privacy is given.",
    input: {
      title: z.string().min(1).max(150),
      privacy: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).default("PRIVATE"),
      description: z.string().max(5000).optional(),
    },
    destructive: false,
  },
  youtube_delete_playlist: {
    description:
      "Permanently delete one of the authenticated account's playlists by its PL playlist ID.",
    input: { playlist_id: z.string().regex(userPlaylistId) },
    destructive: true,
  },
  youtube_add_to_playlist: {
    description:
      "Add up to 50 videos to one of the account's playlists or to Watch Later (WL).",
    input: { playlist_id: editablePlaylist, video_ids: videoBatch },
    destructive: false,
  },
  youtube_remove_from_playlist: {
    description:
      "Remove up to 50 videos from one of the account's playlists or from Watch Later (WL).",
    input: { playlist_id: editablePlaylist, video_ids: videoBatch },
    destructive: true,
  },
  youtube_update_playlist: {
    description:
      "Change the title and/or description of one of the account's PL playlists.",
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
      "Move a video so it follows another video in a PL playlist or Watch Later (WL).",
    input: {
      playlist_id: editablePlaylist,
      video_id: videoId,
      after_video_id: videoId,
    },
    destructive: false,
    check: (input) => input.video_id !== input.after_video_id,
  },
  youtube_like_video: {
    description: "Like a video on the authenticated account.",
    input: { video_id: videoId },
    destructive: false,
  },
  youtube_remove_rating: {
    description:
      "Remove the authenticated account's like or dislike from a video.",
    input: { video_id: videoId },
    destructive: true,
  },
};
