# Upstream boundaries

Behaviour of YouTube and YouTube.js that this server depends on. Library
statements were checked against the installed `youtubei.js` 18.3.0 source and
upstream `main` at `ec7ef07` (2026-11-04). Live statements come from approved
checks that printed key paths and enum constants only; no response body,
identifier or credential was kept.

## YouTube.js defects worked around

| Function | Defect | Upstream (`main` `ec7ef07`) | What this server does |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `PlaylistManager.delete()` | Builds `deletePlaylistServiceEndpoint` with `sourcePlaylistId`, but `DeletePlaylistEndpoint.buildRequest()` copies it only when a `playlistId` field exists, so the body names no playlist | Same code; no issue or pull request (2026-11-11) | Posts `{ playlistId }` to `playlist/delete` |
| `PlaylistManager.setName()` | Puts the ID under `playlist_id`, which `PlaylistEditEndpoint.buildRequest()` ignores, so the edit names no playlist | Same code; no issue or pull request (2026-11-11) | Posts `ACTION_SET_PLAYLIST_NAME` with `playlistId` to `browse/edit_playlist` |

Related upstream work: #898 (merged) fixed a doubled `VL` prefix in the
private `#getPlaylist()`, unrelated to these; open #1284 (and the larger #872)
fixes the same class of body-shape bug for `addToLibrary()` and
`removeFromLibrary()`, which this server does not use. Revisit both rows when
YouTube.js changes these files; until then no write goes through a
`PlaylistManager` or `InteractionManager` method.

## Session and identity

- `Innertube.create({ cookie, account_index: 0, retrieve_player: false, enable_session_cache: false })` accepts a Cookie header string. No disk cache
  will be supplied. Player retrieval is unnecessary for library reads.
- `dist/src/utils/HTTPClient.js` adds cookies and derives SAPISID authentication.
  `Session.logged_in` is initially just `!!cookie`; it is **not** proof of login.
- `account.getInfo()` uses the TV accounts-list endpoint, but channel footers
  are optional. A public MediaServiceCore accounts-list fixture has no footer.
  Do not assume that method provides a stable channel ID.
- Identity uses a fixed read-only `/browse` request for `SPaccount_advanced`,
  parsed by YouTube.js. Accept exactly one distinct `UC` plus 22-character ID
  from `CopyLink.short_url`; fail closed if absent or ambiguous. This settings
  read is documented in upstream issue #783. Do not use display names, cookie
  hashes, mutable handles, or account-switch tokens as identity. Accounts
  without an identifiable channel fail safely. The approved live smoke check
  verified this identity read on one account, not universal compatibility.
- Generate session context locally and disable Innertube config/player
  retrieval. This avoids unrelated bootstrap requests and lets transport
  restrict authenticated traffic to named routes.
- `account.getInfo(true)` lists accounts using WEB and has `is_selected`, but
  `AccountItem` does not expose a stable channel ID as a dedicated field. Do not
  execute switch-account service endpoints to derive identity.
- `Log.setLevel(Log.Level.NONE)` disables upstream console diagnostics before
  constructing a client. Do not return raw errors, request bodies, or headers.

## Read routes

- `getPlaylists()`, `getPlaylist("WL")`, `getPlaylist("LL")`, and `getHistory()`
  provide read surfaces. Continuation processing must preserve remaining items.
- `getChannelsFeed()` browses `FEchannels`, the subscribed-channel list. Its
  `Channel` parser notes that `subscriberCountText` now carries the handle and
  `videoCountText` the subscriber count. The bell setting is the
  `SubscriptionNotificationToggleButton` state whose `stateId` equals
  `currentStateId`; state IDs are opaque, so the icon (`NOTIFICATIONS_ACTIVE`,
  `NOTIFICATIONS_NONE`, `NOTIFICATIONS_OFF`) decides the setting.
- Channel uploads browse the `UC` channel ID with the Videos-tab params
  `EgZ2aWRlb3PyBgQKAjoA` in one request, instead of `getChannel()` followed by
  `getVideos()`, which first loads the channel home and follows its tab
  endpoint. The tab content is a `richGridRenderer` of `videoRenderer` or video
  `lockupViewModel` items; on this tab lockup metadata rows carry views and the
  upload label, not the channel name. Live, a channel without uploads had no
  Videos tab; YouTube selected its Playlists tab instead, whose endpoint params
  differ, so a selected tab with other params reads as no uploads. A made-up
  `UC` ID answered HTTP 200 with an `ERROR` alert "This channel does not
  exist." and no contents.
- Playlist continuations now repeat an empty tab shell in `contents` beside
  `onResponseReceivedActions`; continuation reads use only the appended items.
- A playlist with no videos shows a `messageRenderer` reading "No videos in
  this playlist yet" (newly created playlists) or "This playlist has no
  videos."; both read as an empty list.
- New user playlists get `PL` plus 11 characters; older ones `PL` plus 32.
- A playlist page carries its title and description in
  `metadata.playlistMetadataRenderer` (no `description` key when empty) and its
  privacy only as a header label, `Private`, `Unlisted` or `Public`, among
  `pageHeaderViewModel` metadata parts; `microformat` holds just an `unlisted`
  flag. The session language is fixed to English, so the labels are stable
  for this server.

Local source references are under `node_modules/youtubei.js/dist/src/`:
`core/Session.js`, `core/managers/AccountManager.js`, `utils/HTTPClient.js`,
`utils/Log.js`, `parser/youtube/AccountInfo.js`,
`parser/classes/AccountSectionList.js`, `parser/classes/AccountChannel.js`,
`parser/classes/SettingsOptions.js`, and `parser/classes/CopyLink.js`.

Latest upstream inspected: `204715b6acfb063dc306d8677e36fdbf09f293c5`
(`v18.3.0`). AccountItem still has no dedicated immutable channel-ID property.
Issue <https://github.com/LuanRT/YouTube.js/issues/783> is a closed historical
accounts-list 400 report, not proof of a current regression or released fix.
The settings fixture used here is source-derived and synthetic, not captured
personal account data. Library fixture provenance is documented under
`tests/fixtures/library/README.md`.

The approved live check exposed local normalization gaps already handled by
installed 18.1.0 and the inspected upstream commit:

- `ContinuationItemView` wraps a `continuationCommand` navigation endpoint.
  Upstream PR #1193 is merged; installed source includes that class.
- `NavigationEndpoint` unwraps `innertubeCommand` and supports command-executor
  bundles (merged PR #968). Our adapter extracts only the single browse token;
  it never executes other commands embedded in a response.
- `ReelShelf.items` and `ShortsLockupView.onTap` / `overlayMetadata` describe
  history Shorts. Normalize them in place to retain order and date grouping.

A later approved live read found two more fields that installed 18.1.0 parses
(`ThumbnailOverlayBadgeView`, `ContentMetadataView`) but our raw normalizer
skipped:

- Lockup playlists carry their size only as a thumbnail badge text such as
  `N videos` or `N lessons`. Mixes show `Mix` and keep a null count.
- Video lockups put the channel in the first metadata row part.
- Some `playlistVideoRenderer` items omit `shortBylineText`, `ownerText`, and
  `longBylineText` entirely while staying playable with length and view data.
  They are not multi-channel collaborations; the cause is unknown. Their
  `channel_name` stays null because recovering it would need per-video `/next`
  reads outside the fixed browse endpoint.
- History Shorts carry no channel in the browse response.

Shape-only live observations became synthetic regression cases in
`tests/protocol/modern-layouts.test.ts`. No live response bodies, identifiers,
or credential-bearing payloads were copied into fixtures. No dependency
upgrade or upstream patch was required.

A third approved live read failed `youtube_list_playlists` with
`UPSTREAM_CHANGED`: saved courses now arrive in the playlist grid as
`LOCKUP_CONTENT_TYPE_COURSE` lockups with a `PL` playlist ID and an
`N lessons` badge. Upstream added the same content type to `LockupView` and to
the playlist filter in `Feed` (merged PR #1313, released in 18.3.0), so the
change is on YouTube's side. Because reads use `parse: false`, the upgrade to
18.3.0 alone could not fix this; the normalizer accepts course lockups itself.
Between 18.1.0 and 18.3.0 the only change on our request path is an optional
chain in `Session` for remotely fetched config, which is unused because the
session context is generated locally.

## Write routes

Each operation names the routes it may reach; the transport compares the whole
request path against that set, so a `browse` grant never covers
`browse/edit_playlist`. Reads grant only `browse`; each write grants only its
route, and the reads a move or bell change needs run separately under
`browse`. Routes are the API paths of the YouTube.js 18.3.0 endpoint classes.
Bodies are built here, never by the YouTube.js managers.

| Tool | Route | Body | Confirmation in the answer |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| create playlist | `playlist/create` | `title`, `privacyStatus`, `videoIds: []`, optional `description` | `playlistId` matching `PL` plus 10–64 characters |
| delete playlist | `playlist/delete` | `playlistId` | none beyond a 2xx answer |
| add, remove videos | `browse/edit_playlist` | `playlistId`, one `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` per video | `status: STATUS_SUCCEEDED` |
| update playlist | `browse/edit_playlist` | `ACTION_SET_PLAYLIST_NAME`, `ACTION_SET_PLAYLIST_DESCRIPTION` | `status: STATUS_SUCCEEDED` |
| move in playlist | `browse/edit_playlist` | `ACTION_MOVE_VIDEO_AFTER` with `setVideoId`, `movedSetVideoIdPredecessor` | `status: STATUS_SUCCEEDED` |
| like, remove rating | `like/like`, `like/removelike` | `target: { videoId }` | a `likeStatusEntity` mutation with `LIKE` / `INDIFFERENT` |
| subscribe, unsubscribe | `subscription/subscribe`, `/unsubscribe` | `channelIds`, `params` `EgIIAhgA` / `CgIIAhgA` | `actions[].updateSubscribeButtonAction` with the channel and new state |
| notification bell | `notification/modify_channel_preference` | `params` from the channel's bell menu | a `subscriptionNotificationStateEntity.state` of `…_ALL`, `…_OCCASIONAL` (personalized) or `…_OFF` |

Notes:

- Removal by video ID needs no prior read, unlike `removeVideos()`, which pages
  through the playlist for set IDs. Live, it removed every entry of the video,
  including a duplicate.
- Moves read `setVideoId` from `playlistVideoRenderer` items as `moveVideo()`
  does, but over a bounded, complete read (60 pages) so a duplicate entry is
  detected before anything is sent.
- `InteractionManager.like()` and `removeRating()` send a bare `target` string
  as the TV client. This session is WEB; the web body `{ target: { videoId } }`
  was confirmed live. Create, like and subscribe answers also carry
  `runAttestationCommand` actions, which are never executed.
- `InteractionManager.setNotificationPreferences()` encodes its own
  `NotificationPreferences` protobuf. Instead, the bell tool reads the
  channel's FEchannels bell dropdown, whose `menuServiceItemRenderer` items
  pair an icon (`NOTIFICATIONS_ACTIVE`, `NOTIFICATIONS_NONE`,
  `NOTIFICATIONS_OFF`) with `modifyChannelNotificationPreferenceEndpoint`
  params, and posts the params of the one item with the wanted icon.
- A rejected write answers 4xx; any other failure after sending is reported as
  `WRITE_OUTCOME_UNKNOWN`, because YouTube may have applied it.

## Chromium CDP

Reference: <https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getCookies>.

Use the browser WebSocket from `/json/version`, then:

1. `Target.getTargets` and `Target.getBrowserContexts` to exclude non-default
   browser contexts; select an existing page without navigating it.
1. `Target.attachToTarget` with `flatten: true`.
1. `Network.getCookies` on that session with the fixed URL
   `https://www.youtube.com/` (includes HttpOnly cookies).
1. `Target.detachFromTarget`, then close only the CDP connection.

No browser launch, page creation, JavaScript evaluation, cookie mutation, or
browser shutdown commands are needed. No default-context page means a safe
browser-unavailable failure, not an automatic tab creation.

`YOUTUBE_CDP_URL` is operator configuration, never an MCP argument. Discovery
redirects and mismatched WebSocket authorities are rejected. Discovery's
loopback hostname/port can be rewritten to the operator's authority for SSH or
container port forwarding; paths remain under `/devtools/browser/`.

Even URL-scoped CDP results are filtered for exact cookie applicability and
header safety. Partitioned cookies require a matching YouTube top-level site
and no cross-site ancestor; opaque or unknown partition keys are discarded.
Expired cookies and unrelated domains/paths never enter the session header.
No profile database or cookie export file is read or written.

The CDP connection itself grants full browser authority. A restricted adapter
is not a credential vault or a substitute for host/network isolation.
