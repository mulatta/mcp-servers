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

// User playlists: new ones get "PL" plus 11 characters, older ones "PL" plus 32.
export const userPlaylistId = /^PL[A-Za-z0-9_-]{10,64}$/;

// Write tools by group; a tool is registered only when its group is enabled.
export const writeToolGroups = {
  youtube_create_playlist: "playlist",
  youtube_delete_playlist: "playlist",
} as const satisfies Record<string, WriteGroup>;
export type WriteToolName = keyof typeof writeToolGroups;
export const writeToolNames = Object.keys(writeToolGroups) as WriteToolName[];
export const allToolNames = [...toolNames, ...writeToolNames] as [
  ToolName | WriteToolName,
  ...(ToolName | WriteToolName)[],
];
export type AnyToolName = ToolName | WriteToolName;
