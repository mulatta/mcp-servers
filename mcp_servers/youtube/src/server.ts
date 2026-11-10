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
          inputSchema: z.strictObject(definition.input),
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

const writeTools: Record<
  WriteToolName,
  { description: string; input: z.ZodRawShape; destructive: boolean }
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
};
