import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolNames, type ToolName } from "../../src/server.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { SafeError, safeError } from "../../src/errors.ts";
import { z } from "zod";

const failureSchema = z.object({
  code: z.enum([
    "BROWSER_UNAVAILABLE",
    "AUTH_REQUIRED",
    "ACCOUNT_CHANGED",
    "CURSOR_INVALID",
    "CURSOR_EXPIRED",
    "PLAYLIST_UNAVAILABLE",
    "RATE_LIMITED",
    "UPSTREAM_BLOCKED",
    "UPSTREAM_CHANGED",
    "UPSTREAM_UNAVAILABLE",
    "TIMEOUT",
  ]),
});
export type CheckReport = {
  tool: ToolName;
  requested: number;
  status: "ok" | "error";
  items?: number;
  has_more?: boolean;
  account_consistent?: boolean;
  null_fields?: string[];
  code?: string;
  elapsed_ms: number;
};

export async function checkTools(client: Client): Promise<CheckReport[]> {
  let accountId: string | undefined;
  // WL is a real readable playlist even when no account playlist is listed.
  let playlistId = "WL";
  const reports: CheckReport[] = [];
  for (const name of toolNames) {
    const started = performance.now();
    const base = { tool: name, requested: 5 };
    try {
      const response = await client.callTool({
        name,
        arguments: {
          limit: 5,
          ...(name === "youtube_get_playlist"
            ? { playlist_id: playlistId }
            : {}),
        },
      });
      if (response.isError) {
        if (Array.isArray(response.content))
          for (const item of response.content) {
            if (item.type !== "text" || typeof item.text !== "string") continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(item.text);
            } catch {
              continue;
            }
            const failure = failureSchema.safeParse(parsed);
            if (failure.success) throw new SafeError(failure.data.code);
          }
        throw new SafeError("UPSTREAM_UNAVAILABLE");
      }
      const result = resultSchema.parse(response.structuredContent);
      if (accountId && result.account_id !== accountId)
        throw new SafeError("ACCOUNT_CHANGED");
      accountId = result.account_id;
      if (result.items.length > 5) throw new SafeError("UPSTREAM_CHANGED");
      if (name === "youtube_list_playlists") {
        const first = result.items.find(
          (item) => "playlist_id" in item && item.playlist_id,
        );
        if (first && "playlist_id" in first && first.playlist_id)
          playlistId = first.playlist_id;
      }
      // shortcut: field moves inside known lockups are caught only by this live check,
      // move field extraction onto youtubei.js parsers if another such fix is needed.
      const nullFields = result.items.length
        ? ["video_count", "channel_name"].filter((field) =>
            result.items.every(
              (item) =>
                field in item && item[field as keyof typeof item] === null,
            ),
          )
        : [];
      reports.push({
        ...base,
        status: "ok",
        items: result.items.length,
        has_more: result.has_more,
        account_consistent: true,
        null_fields: nullFields,
        elapsed_ms: Math.round(performance.now() - started),
      });
    } catch (error) {
      reports.push({
        ...base,
        status: "error",
        code: safeError(error).code,
        elapsed_ms: Math.round(performance.now() - started),
      });
    }
  }
  return reports;
}
