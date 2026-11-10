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
