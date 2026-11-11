import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { toolNames } from "../../src/server.ts";
import type { ReadToolName } from "../../src/tools.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { SafeError, isErrorCode, safeError } from "../../src/errors.ts";
import { z } from "zod";

const failureSchema = z.object({ code: z.string().refine(isErrorCode) });
export type CheckReport = {
  tool: ReadToolName;
  requested: number;
  status: "ok" | "error";
  items?: number;
  has_more?: boolean;
  account_consistent?: boolean;
  null_fields?: string[];
  code?: string;
  elapsed_ms: number;
};

// Reconstructs the safe error a tool returned, so reports carry only its code.
function failure(content: unknown): SafeError {
  if (Array.isArray(content))
    for (const item of content) {
      if (item?.type !== "text" || typeof item.text !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(item.text);
      } catch {
        continue;
      }
      const result = failureSchema.safeParse(parsed);
      if (result.success && isErrorCode(result.data.code))
        return new SafeError(result.data.code);
    }
  return new SafeError("UPSTREAM_UNAVAILABLE");
}

const detailsSchema = z.strictObject({
  account_id: z.string(),
  playlist_id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  privacy: z.enum(["private", "unlisted", "public"]).nullable(),
});

export async function checkTools(client: Client): Promise<CheckReport[]> {
  let accountId: string | undefined;
  // WL is a real readable playlist even when no account playlist is listed.
  let playlistId = "WL";
  // The account's own channel is readable even when no subscription is listed.
  let channelId: string | undefined;
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
            : name === "youtube_get_channel_videos"
              ? { channel_id: channelId ?? accountId }
              : {}),
        },
      });
      if (response.isError) throw failure(response.content);
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
      if (name === "youtube_list_subscriptions") {
        const first = result.items.find(
          (item) => "channel_id" in item && item.channel_id,
        );
        if (first && "channel_id" in first && first.channel_id)
          channelId = first.channel_id;
      }
      // shortcut: field moves inside known lockups are caught only by this live check,
      // move field extraction onto youtubei.js parsers if another such fix is needed.
      const nullFields = result.items.length
        ? ["video_count", "channel_name", "handle", "notification"].filter(
            (field) =>
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
  // The details read targets the playlist found above and reports only nulls.
  const started = performance.now();
  const base = { tool: "youtube_get_playlist_details" as const, requested: 1 };
  try {
    const response = await client.callTool({
      name: "youtube_get_playlist_details",
      arguments: { playlist_id: playlistId },
    });
    if (response.isError) throw failure(response.content);
    const result = detailsSchema.parse(response.structuredContent);
    if (accountId && result.account_id !== accountId)
      throw new SafeError("ACCOUNT_CHANGED");
    reports.push({
      ...base,
      status: "ok",
      account_consistent: true,
      null_fields: (["title", "description", "privacy"] as const).filter(
        (field) => result[field] === null,
      ),
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
  return reports;
}
