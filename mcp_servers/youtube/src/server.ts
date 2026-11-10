import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errorResult, SafeError } from "./errors.ts";
import { withDeadline } from "./deadline.ts";
import { withRequest } from "./observability/trace.ts";
import type { Logger } from "./observability/logger.ts";

export const toolNames = [
  "youtube_list_playlists",
  "youtube_get_playlist",
  "youtube_get_watch_later",
  "youtube_get_liked_videos",
  "youtube_get_watch_history",
] as const;
export type ToolName = (typeof toolNames)[number];
export interface ReadInput {
  limit: number;
  cursor?: string | undefined;
  playlist_id?: string | undefined;
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
};

export function createServer(
  reader: Reader = async () => {
    throw new SafeError("UPSTREAM_UNAVAILABLE");
  },
  options: { timeoutMs?: number; logger?: Logger } = {},
) {
  const server = new McpServer({ name: "youtube-mcp", version: "0.0.0" });
  const paging = {
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(256).optional(),
  };
  for (const name of toolNames) {
    const inputSchema =
      name === "youtube_get_playlist"
        ? z.strictObject({
            ...paging,
            playlist_id: z.string().regex(/^[A-Za-z0-9_-]{2,150}$/),
          })
        : z.strictObject(paging);
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
  return server;
}
