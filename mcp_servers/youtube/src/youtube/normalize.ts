import { z } from "zod";
import { SafeError } from "../errors.ts";

const playlistSummary = z.strictObject({
  playlist_id: z.string().nullable(),
  title: z.string().nullable(),
  video_count: z.number().int().nonnegative().nullable(),
});
const videoSummary = z.strictObject({
  video_id: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  channel_name: z.string().nullable(),
  availability: z
    .enum(["available", "private", "deleted", "unavailable"])
    .nullable(),
  // Null means YouTube showed no progress, which covers both unwatched and unknown.
  watched_percent: z.number().int().min(0).max(100).nullable(),
  duration_seconds: z.number().int().nonnegative().nullable(),
  watched_at: z.string().nullable().optional(),
  group_label: z.string().nullable().optional(),
  published_text: z.string().nullable().optional(),
  channel_id: z.string().nullable().optional(),
  is_upcoming: z.boolean().optional(),
});
const channelSummary = z.strictObject({
  channel_id: z.string().nullable(),
  title: z.string().nullable(),
  handle: z.string().nullable(),
  subscriber_count_text: z.string().nullable(),
  notification: z.enum(["all", "personalized", "none"]).nullable(),
});
export const resultSchema = z.strictObject({
  account_id: z.string().min(1),
  items: z.array(z.union([playlistSummary, videoSummary, channelSummary])),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export type Item =
  | z.infer<typeof playlistSummary>
  | z.infer<typeof videoSummary>
  | z.infer<typeof channelSummary>;
export type Page = { items: Item[]; continuation: string | null };
export type Result = z.infer<typeof resultSchema>;
export type Kind =
  | "videos"
  | "playlists"
  | "history"
  | "channels"
  | "channel_videos"
  | "subscription_feed";

// Browse params selecting a channel's Videos tab, newest first.
export const channelVideosParams = "EgZ2aWRlb3PyBgQKAjoA";

export type PlaylistDetails = {
  title: string | null;
  description: string | null;
  privacy: "private" | "unlisted" | "public" | null;
};
const privacyLabels: Record<string, PlaylistDetails["privacy"]> = {
  Private: "private",
  Unlisted: "unlisted",
  Public: "public",
};

/**
 * Title and description come from the playlist metadata; privacy only from a
 * single exact label among the page header's metadata parts.
 */
export function playlistDetails(raw: unknown): PlaylistDetails {
  const response = object(raw);
  const metadata = object(object(response.metadata).playlistMetadataRenderer);
  const header = object(
    object(object(response.header).pageHeaderRenderer).content,
  ).pageHeaderViewModel;
  if (!Object.keys(metadata).length && !header)
    throw new SafeError("UPSTREAM_CHANGED");
  const rows = object(
    object(object(header).metadata).contentMetadataViewModel,
  ).metadataRows;
  const labels = new Set<PlaylistDetails["privacy"]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const parts = object(row).metadataParts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const label = text(object(part).text);
      if (label !== null && Object.hasOwn(privacyLabels, label))
        labels.add(privacyLabels[label]!);
    }
  }
  return {
    title: typeof metadata.title === "string" ? metadata.title : null,
    description:
      typeof metadata.description === "string" ? metadata.description : null,
    privacy: labels.size === 1 ? [...labels][0]! : null,
  };
}

export function resultEnvelope(
  accountId: string,
  items: Item[],
  cursor: string | null,
): Result {
  return resultSchema.parse({
    account_id: accountId,
    items,
    next_cursor: cursor,
    has_more: cursor !== null,
  });
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  const v = object(value);
  if (typeof v.simpleText === "string") return v.simpleText;
  if (typeof v.content === "string") return v.content;
  if (
    Array.isArray(v.runs) &&
    v.runs.every((r) => typeof object(r).text === "string")
  )
    return v.runs.map((r) => object(r).text).join("");
  return null;
}
function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}
// Lockup playlists carry their size only as a thumbnail badge such as "3,890 videos".
function badgeCount(lockup: Record<string, unknown>): number | null {
  const thumbnail = object(
    object(
      object(object(lockup.contentImage).collectionThumbnailViewModel)
        .primaryThumbnail,
    ).thumbnailViewModel,
  );
  for (const overlay of Array.isArray(thumbnail.overlays)
    ? thumbnail.overlays
    : []) {
    const badges = object(
      object(overlay).thumbnailOverlayBadgeViewModel,
    ).thumbnailBadges;
    for (const badge of Array.isArray(badges) ? badges : []) {
      const match = /^([\d,]+) (?:videos?|lessons?)$/.exec(
        String(object(object(badge).thumbnailBadgeViewModel).text),
      );
      if (match) return Number(match[1]!.replaceAll(",", ""));
    }
  }
  return null;
}
function percent(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
    ? Number(value)
    : null;
}
// Only exact clock labels count; "LIVE", "Mix" or malformed text stays unknown.
function clock(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(?:(\d+):([0-5]\d)|(\d{1,2})):([0-5]\d)$/.exec(value);
  if (!match) return null;
  const [, hours, hourMinutes, minutes, seconds] = match;
  return hours !== undefined
    ? Number(hours) * 3600 + Number(hourMinutes) * 60 + Number(seconds)
    : Number(minutes) * 60 + Number(seconds);
}
function duration(
  video: Record<string, unknown>,
  lockup: Record<string, unknown>,
): number | null {
  if (video.lengthSeconds !== undefined)
    return typeof video.lengthSeconds === "string" &&
      /^\d+$/.test(video.lengthSeconds)
      ? Number(video.lengthSeconds)
      : null;
  const length = text(video.lengthText);
  if (length !== null) return clock(length);
  for (const overlay of Array.isArray(video.thumbnailOverlays)
    ? video.thumbnailOverlays
    : []) {
    const status = object(overlay).thumbnailOverlayTimeStatusRenderer;
    if (status) return clock(text(object(status).text));
  }
  const found = new Set<number | null>();
  const thumbnail = object(object(lockup.contentImage).thumbnailViewModel);
  for (const overlay of Array.isArray(thumbnail.overlays)
    ? thumbnail.overlays
    : []) {
    const o = object(overlay);
    const badges = [
      object(o.thumbnailOverlayBadgeViewModel).thumbnailBadges,
      object(o.thumbnailBottomOverlayViewModel).badges,
    ].flatMap((list) => (Array.isArray(list) ? list : []));
    for (const badge of badges) {
      const seconds = clock(object(object(badge).thumbnailBadgeViewModel).text);
      if (seconds !== null) found.add(seconds);
    }
  }
  // Two different clocks on one lockup are ambiguous, so neither is reported.
  return found.size === 1 ? [...found][0]! : null;
}
// Renderers carry a resume overlay; lockups carry a bottom progress bar.
function watchedPercent(
  video: Record<string, unknown>,
  lockup: Record<string, unknown>,
): number | null {
  for (const overlay of Array.isArray(video.thumbnailOverlays)
    ? video.thumbnailOverlays
    : []) {
    const resume = object(overlay).thumbnailOverlayResumePlaybackRenderer;
    if (resume) return percent(object(resume).percentDurationWatched);
  }
  const thumbnail = object(object(lockup.contentImage).thumbnailViewModel);
  for (const overlay of Array.isArray(thumbnail.overlays)
    ? thumbnail.overlays
    : []) {
    const bar = object(
      object(object(overlay).thumbnailBottomOverlayViewModel).progressBar,
    ).thumbnailOverlayProgressBarViewModel;
    if (bar) return percent(object(bar).startPercent);
  }
  return null;
}
const bells: Record<string, "all" | "personalized" | "none"> = {
  NOTIFICATIONS_ACTIVE: "all",
  NOTIFICATIONS_NONE: "personalized",
  NOTIFICATIONS_OFF: "none",
};
// State IDs are opaque, so the bell is read from the icon of the current state.
function notification(
  channel: Record<string, unknown>,
): "all" | "personalized" | "none" | null {
  const toggle = object(
    object(
      object(object(channel.subscribeButton).subscribeButtonRenderer)
        .notificationPreferenceButton,
    ).subscriptionNotificationToggleButtonRenderer,
  );
  const states = Array.isArray(toggle.states) ? toggle.states : [];
  const current = states.filter(
    (state) =>
      toggle.currentStateId !== undefined &&
      object(state).stateId === toggle.currentStateId,
  );
  if (current.length !== 1) return null;
  const icon = object(
    object(object(object(current[0]).state).buttonRenderer).icon,
  ).iconType;
  return typeof icon === "string" ? (bells[icon] ?? null) : null;
}
// Upload dates are relative labels; lockups mix them with view counts in metadata rows.
function published(
  video: Record<string, unknown>,
  rows: unknown[],
): string | null {
  const label = text(video.publishedTimeText);
  if (label) return label;
  for (const row of rows) {
    const parts = object(row).metadataParts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const value = text(object(part).text);
      if (value && / ago$/.test(value)) return value;
    }
  }
  return null;
}
// Feed lockups link the channel name in their first metadata row; a
// collaboration opens a dialog instead and has no single channel.
function linkedChannel(rows: unknown[]): string | null {
  const part = object(first(object(first(rows)).metadataParts));
  const runs = object(part.text).commandRuns;
  const ids = new Set<string>();
  for (const run of Array.isArray(runs) ? runs : []) {
    const browseId = object(
      object(object(object(run).onTap).innertubeCommand).browseEndpoint,
    ).browseId;
    const channel = id(browseId, /^UC[A-Za-z0-9_-]{22}$/);
    if (channel) ids.add(channel);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}
function badgeTexts(lockup: Record<string, unknown>): string[] {
  const thumbnail = object(object(lockup.contentImage).thumbnailViewModel);
  const texts: string[] = [];
  for (const overlay of Array.isArray(thumbnail.overlays)
    ? thumbnail.overlays
    : []) {
    const o = object(overlay);
    for (const badge of [
      object(o.thumbnailOverlayBadgeViewModel).thumbnailBadges,
      object(o.thumbnailBottomOverlayViewModel).badges,
    ].flatMap((list) => (Array.isArray(list) ? list : []))) {
      const value = object(object(badge).thumbnailBadgeViewModel).text;
      if (typeof value === "string") texts.push(value);
    }
  }
  return texts;
}
function id(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SafeError("UPSTREAM_CHANGED");
  return value;
}

function continuationToken(endpoint: unknown): string {
  const tokens = new Set<string>();
  let visited = 0;
  function visit(value: unknown, depth = 0) {
    if (depth > 8 || ++visited > 64) throw new SafeError("UPSTREAM_CHANGED");
    const command = object(value);
    const continuation = object(command.continuationCommand);
    if (typeof continuation.token === "string" && continuation.token) {
      if (
        continuation.request !== undefined &&
        continuation.request !== "CONTINUATION_REQUEST_TYPE_BROWSE"
      )
        throw new SafeError("UPSTREAM_CHANGED");
      tokens.add(continuation.token);
    }
    for (const key of ["innertubeCommand", "command", "performOnceCommand"]) {
      if (command[key]) visit(command[key], depth + 1);
    }
    const commands = object(command.commandExecutorCommand).commands;
    if (commands !== undefined)
      for (const nested of list(commands)) visit(nested, depth + 1);
  }
  // Extract only the browse token; UI and mutation commands are never executed.
  visit(endpoint);
  if (tokens.size !== 1) throw new SafeError("UPSTREAM_CHANGED");
  return [...tokens][0]!;
}

export function normalize(
  raw: unknown,
  kind: Kind,
  options: { continuation?: boolean } = {},
): Page {
  const page: Page = { items: [], continuation: null };
  let recognized = false;
  const videoId = /^[A-Za-z0-9_-]{11}$/;
  const playlistId = /^[A-Za-z0-9_-]{2,150}$/;
  function walk(node: unknown, group: string | null = null): void {
    const n = object(node);
    if (
      n.twoColumnBrowseResultsRenderer ||
      n.singleColumnBrowseResultsRenderer
    ) {
      const tabs = list(
        object(
          n.twoColumnBrowseResultsRenderer ??
            n.singleColumnBrowseResultsRenderer,
        ).tabs,
      );
      const selected = tabs
        .map((t) => object(object(t).tabRenderer))
        .filter((t) => t.selected === true);
      if (selected.length !== 1) throw new SafeError("UPSTREAM_CHANGED");
      if (kind === "channel_videos") {
        // The account's own channel without uploads shows the owner one tab
        // without an endpoint, holding an upload prompt.
        if (selected[0]!.endpoint === undefined) {
          const sections = list(
            object(object(selected[0]!.content).sectionListRenderer).contents,
          );
          if (
            !sections.some(
              (section) => object(section).channelOwnerEmptyStateRenderer,
            )
          )
            throw new SafeError("UPSTREAM_CHANGED");
          recognized = true;
          return;
        }
        // A channel without uploads has no Videos tab; YouTube then selects
        // another tab, recognisable by different params on its endpoint.
        const params = object(
          object(selected[0]!.endpoint).browseEndpoint,
        ).params;
        if (typeof params !== "string") throw new SafeError("UPSTREAM_CHANGED");
        if (params !== channelVideosParams) {
          recognized = true;
          return;
        }
      }
      return walk(selected[0]!.content, group);
    }
    for (const key of [
      "sectionListRenderer",
      "itemSectionRenderer",
      "playlistVideoListRenderer",
      "richGridRenderer",
      "gridRenderer",
      "reelShelfRenderer",
      "expandedShelfContentsRenderer",
      "playlistVideoListContinuation",
      "sectionListContinuation",
      "itemSectionContinuation",
    ]) {
      if (!n[key]) continue;
      const container = object(n[key]);
      recognized = true;
      const label =
        text(
          object(object(container.header).itemSectionHeaderRenderer).title,
        ) ?? group;
      // An account that follows no channel gets a first page whose section
      // list has no contents at all; other lists say empty with a message.
      if (
        kind === "channels" &&
        key === "sectionListRenderer" &&
        !options.continuation &&
        container.contents === undefined &&
        container.items === undefined
      )
        return;
      let children = list(container.contents ?? container.items);
      // Playlist section-level continuations are recommendations, not list contents.
      if (key === "sectionListRenderer" && kind === "videos") {
        const lists = children.flatMap((child) => {
          const direct = object(child);
          if (direct.playlistVideoListRenderer) return [child];
          const nested = object(direct.itemSectionRenderer).contents;
          return Array.isArray(nested)
            ? nested.filter((x) => object(x).playlistVideoListRenderer)
            : [];
        });
        if (lists.length) children = lists;
      }
      for (const child of children) walk(child, label);
      if (Array.isArray(container.continuations))
        for (const continuation of container.continuations) {
          const token = object(
            object(continuation).nextContinuationData,
          ).continuation;
          setContinuation(token);
        }
      return;
    }
    if (n.richItemRenderer)
      return walk(object(n.richItemRenderer).content, group);
    // The feed's sections hold a header-only "Latest" shelf and the "Most
    // relevant" and Shorts shelves, which reorder or repeat feed items.
    if (n.richSectionRenderer && kind === "subscription_feed") {
      recognized = true;
      return;
    }
    // An account that follows no channel gets channel suggestions instead.
    if (n.gridChannelRenderer && kind === "subscription_feed") {
      recognized = true;
      return;
    }
    if (n.shelfRenderer) return walk(object(n.shelfRenderer).content, group);
    if (n.continuationItemRenderer || n.continuationItemViewModel) {
      recognized = true;
      setContinuation(
        continuationToken(
          n.continuationItemRenderer
            ? object(n.continuationItemRenderer).continuationEndpoint
            : object(n.continuationItemViewModel).continuationCommand,
        ),
      );
      return;
    }
    if (n.messageRenderer) {
      // A recognized explicit message is YouTube's empty-list representation.
      const message = text(object(n.messageRenderer).text);
      if (
        !message ||
        ![
          "This playlist has no videos.",
          "No videos in this playlist yet",
          "Your history is empty.",
          "This list has no videos.",
          "No playlists",
        ].includes(message)
      )
        throw new SafeError("UPSTREAM_CHANGED");
      recognized = true;
      return;
    }
    const lockup = object(n.lockupViewModel);
    const lockupMetadata = object(
      object(lockup.metadata).lockupMetadataViewModel,
    );
    const lockupTitle = lockupMetadata.title;
    if (kind === "channels") {
      if (!n.channelRenderer) throw new SafeError("UPSTREAM_CHANGED");
      const c = object(n.channelRenderer);
      // YouTube now puts the handle in subscriberCountText and the size in videoCountText.
      const handle = text(c.subscriberCountText);
      const size = text(c.videoCountText);
      page.items.push({
        channel_id: id(c.channelId, /^UC[A-Za-z0-9_-]{22}$/),
        title: text(c.title),
        handle: handle?.startsWith("@") ? handle : null,
        subscriber_count_text:
          size && / subscribers?$/.test(size) ? size : null,
        notification: notification(c),
      });
    } else if (kind === "playlists") {
      const p = object(n.gridPlaylistRenderer ?? n.playlistRenderer);
      // Saved courses are listed beside playlists and are addressed by a playlist ID.
      if (
        !Object.keys(p).length &&
        lockup.contentType !== "LOCKUP_CONTENT_TYPE_PLAYLIST" &&
        lockup.contentType !== "LOCKUP_CONTENT_TYPE_COURSE"
      )
        throw new SafeError("UPSTREAM_CHANGED");
      const count =
        typeof p.videoCount === "string" && /^\d+$/.test(p.videoCount)
          ? Number(p.videoCount)
          : badgeCount(lockup);
      page.items.push({
        playlist_id: id(p.playlistId ?? lockup.contentId, playlistId),
        title: text(p.title ?? lockupTitle),
        video_count: count,
      });
    } else {
      const v = object(
        n.playlistVideoRenderer ?? n.videoRenderer ?? n.gridVideoRenderer,
      );
      const short = object(n.shortsLockupViewModel);
      const metadataRows = object(
        object(lockupMetadata.metadata).contentMetadataViewModel,
      ).metadataRows;
      const rows = Array.isArray(metadataRows) ? metadataRows : [];
      if (
        !Object.keys(v).length &&
        !n.shortsLockupViewModel &&
        lockup.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO"
      )
        throw new SafeError("UPSTREAM_CHANGED");
      if (v.style === "PLAYLIST_VIDEO_RENDERER_STYLE_RECOMMENDED_VIDEO") return;
      const title = text(
        v.title ?? lockupTitle ?? object(short.overlayMetadata).primaryText,
      );
      const shortEndpoint = object(object(short.onTap).innertubeCommand);
      const vid = id(
        v.videoId ??
          lockup.contentId ??
          object(shortEndpoint.reelWatchEndpoint).videoId,
        videoId,
      );
      const availability =
        title === "[Private video]"
          ? "private"
          : title === "[Deleted video]"
            ? "deleted"
            : v.isPlayable === false
              ? "unavailable"
              : vid
                ? "available"
                : null;
      page.items.push({
        video_id: vid,
        title,
        url: vid ? `https://www.youtube.com/watch?v=${vid}` : null,
        // On a channel's own tab the first lockup row holds views, not the channel.
        channel_name:
          kind === "channel_videos"
            ? null
            : text(
                v.shortBylineText ??
                  v.ownerText ??
                  v.longBylineText ??
                  // Video lockups put the channel first in their metadata rows.
                  object(first(object(first(rows)).metadataParts)).text,
              ),
        availability,
        watched_percent: watchedPercent(v, lockup),
        duration_seconds: duration(v, lockup),
        ...(kind === "history" ? { watched_at: null, group_label: group } : {}),
        ...(kind === "channel_videos"
          ? { published_text: published(v, rows) }
          : {}),
        ...(kind === "subscription_feed"
          ? {
              published_text: published(v, rows),
              channel_id: linkedChannel(rows),
              is_upcoming: badgeTexts(lockup).includes("Upcoming"),
            }
          : {}),
      });
    }
    recognized = true;
  }
  function setContinuation(value: unknown) {
    if (
      typeof value !== "string" ||
      !value ||
      (page.continuation !== null && page.continuation !== value)
    )
      throw new SafeError("UPSTREAM_CHANGED");
    page.continuation = value;
  }
  const response = object(raw);
  // Continuation answers may repeat an empty tab shell in `contents`; their
  // items are only in the appended actions or `continuationContents`.
  if (response.contents && !options.continuation) walk(response.contents);
  else if (response.continuationContents) walk(response.continuationContents);
  else {
    const actions =
      response.onResponseReceivedActions ??
      response.onResponseReceivedEndpoints;
    for (const action of list(actions)) {
      // Every feed answer also tells the client to clear the Subscriptions dot.
      const keys = Object.keys(object(action)).filter(
        (key) => key !== "clickTrackingParams",
      );
      if (
        kind === "subscription_feed" &&
        keys.length === 1 &&
        keys[0] === "resetSubscriptionsUnreadDotCommand"
      )
        continue;
      const items = object(
        object(action).appendContinuationItemsAction,
      ).continuationItems;
      for (const item of list(items)) walk(item);
      recognized = true;
    }
  }
  if (!recognized) throw new SafeError("UPSTREAM_CHANGED");
  return page;
}
