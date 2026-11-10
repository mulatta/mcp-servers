import type { WriteGroup } from "./config.ts";

// Kept apart from server.ts so diagnostics can validate tool names without an import cycle.
export const toolNames = [
  "youtube_list_playlists",
  "youtube_get_playlist",
  "youtube_get_watch_later",
  "youtube_get_liked_videos",
  "youtube_get_watch_history",
  "youtube_list_subscriptions",
  "youtube_get_channel_videos",
] as const;
export type ToolName = (typeof toolNames)[number];
// Read tools that return one object instead of a page of items.
export const detailToolNames = ["youtube_get_playlist_details"] as const;
export type DetailToolName = (typeof detailToolNames)[number];
export type ReadToolName = ToolName | DetailToolName;
export const readToolNames = [...toolNames, ...detailToolNames];

// User playlists: new ones get "PL" plus 11 characters, older ones "PL" plus 32.
export const userPlaylistId = /^PL[A-Za-z0-9_-]{10,64}$/;

// Write tools by group; a tool is registered only when its group is enabled.
export const writeToolGroups = {
  youtube_create_playlist: "playlist",
  youtube_delete_playlist: "playlist",
  youtube_add_to_playlist: "playlist",
  youtube_remove_from_playlist: "playlist",
  youtube_update_playlist: "playlist",
  youtube_move_in_playlist: "playlist",
  youtube_like_video: "rating",
  youtube_remove_rating: "rating",
  youtube_subscribe: "subscription",
  youtube_unsubscribe: "subscription",
  youtube_set_channel_notifications: "notification",
} as const satisfies Record<string, WriteGroup>;
export type WriteToolName = keyof typeof writeToolGroups;
export const writeToolNames = Object.keys(writeToolGroups) as WriteToolName[];
export const allToolNames = [
  ...toolNames,
  ...detailToolNames,
  ...writeToolNames,
] as [AnyToolName, ...AnyToolName[]];
export type AnyToolName = ReadToolName | WriteToolName;
