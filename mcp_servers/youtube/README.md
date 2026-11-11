# YouTube MCP

MCP server for one YouTube account, written in Bun and TypeScript. It reads the
account's library and, when enabled per group, changes playlists, ratings,
subscriptions and notification bells. Authentication comes from a signed-in
Chromium browser over CDP; cookies stay in process memory. The server speaks
MCP over stdio or authenticated HTTP.

- Reads are always available. Writes are off unless `YOUTUBE_WRITES` names
  their group.
- Every tool, read and write, has been checked against a live account; see
  [Verification status](#verification-status) for what that covers.
- [UPSTREAM.md](UPSTREAM.md) records the YouTube and YouTube.js behaviour the
  server depends on, including two YouTube.js defects it works around.

## Development

From the repository root:

```sh
nix develop .#youtube
cd mcp_servers/youtube
bun install --frozen-lockfile
bun run check   # typecheck and Prettier
bun run test    # protocol suite, no browser or account
```

`bun run format` formats TypeScript and JSON in this package. Run `nix fmt`
from the repository root for Markdown and the other repository formats.
Markdown has one formatter (mdformat), so Prettier does not rewrite it. Bun
execution alone does not type-check TypeScript. Dependencies are pinned in
`package.json` and `bun.lock`. `nix develop` and `nix develop .#youtube`
provide the same Bun shell. Nix packaging lives in `nix/youtube.nix`; the
flakelet service module in `nix/flakelet-youtube.nix`.

## Configuration

| Variable | Default | Meaning |
| ---------------------------- | ----------------------- | ------------------------------------------------------------- |
| `YOUTUBE_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint of the signed-in browser |
| `YOUTUBE_WRITES` | unset (read-only) | Write groups to expose, see [Writes](#writes) |
| `YOUTUBE_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `YOUTUBE_TRANSPORT` | `stdio` | `stdio` or `http` |
| `YOUTUBE_HTTP_PORT` | required for HTTP | TCP port, 1–65535 |
| `YOUTUBE_HTTP_TOKEN_FILE` | required for HTTP | File holding the bearer token on one line |
| `YOUTUBE_HTTP_HOST` | `127.0.0.1` | Listen address |
| `YOUTUBE_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted in `Host` |

Any invalid value logs `config.invalid` with a fixed code
(`INVALID_LOG_LEVEL`, `INVALID_TRANSPORT`, `INVALID_HTTP_CONFIG`,
`INVALID_WRITES`) and exits 1 before serving or contacting the browser.
`server.start` lists the enabled write groups. The flakelet module exposes the
same settings as `listenAddress`, `port`, `allowedHosts`, `tokenFile`,
`cdpUrl`, `logLevel` and `writes`.

### Run over stdio

From `mcp_servers/youtube`, run `bun run start`. Configure an MCP client with
command `bun`, arguments `run src/index.ts`, and the absolute path of
`mcp_servers/youtube` as working directory. Stdout carries only MCP messages;
diagnostics go to stderr. Tool discovery needs no browser or credentials.

### Run over HTTP

```sh
YOUTUBE_TRANSPORT=http \
YOUTUBE_HTTP_PORT=8765 \
YOUTUBE_HTTP_TOKEN_FILE=/run/credentials/youtube-mcp/token \
bun run start
```

The server answers stateless Streamable HTTP at `/mcp`. The token must be at
least 32 visible ASCII characters with no whitespace; one trailing newline is
ignored. Generate it with `openssl rand -hex 32`.

Each request is checked in this order: `Host` hostname against the allowlist
(403), `Authorization: Bearer` with a constant-time comparison (401), path
`/mcp` (404), and method `POST` (405). Rejections log `http.rejected` with the
status only. `Host` is matched by hostname without the port; repeated
spellings of one host are accepted, malformed entries refuse to start. Keep
the listener on loopback and put TLS in front; the server speaks plain HTTP.

Every request gets a fresh MCP server; all requests share one browser session,
so concurrent clients share one refresh and one cursor store. Cursors work
across clients but compete for the same 128-entry limit, and an authentication
failure in any request expires every outstanding cursor. A client that
disconnects cancels its request. Every response, including rejections, carries
`Connection: close` and ends its connection: answers are stateless JSON, and a
client that left half-closed keep-alive sockets open once exhausted the file
descriptors of the relay in front of the server.

Client configuration (Claude Code):

```json
{
  "type": "http",
  "url": "https://youtube-mcp.example/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

## Read tools

| Tool | Returns | Required input |
| ---------------------------- | ---------------------------------- | -------------- |
| `youtube_list_playlists` | Account playlists | None |
| `youtube_get_playlist` | Playlist contents | `playlist_id` |
| `youtube_get_watch_later` | Watch Later | None |
| `youtube_get_liked_videos` | Liked videos | None |
| `youtube_get_watch_history` | Watch history | None |
| `youtube_list_subscriptions` | Subscribed channels and their bell | None |
| `youtube_get_channel_videos` | A channel's uploads, newest first | `channel_id` |
| `youtube_get_playlist_details` | One playlist's title, description, privacy | `playlist_id` |
| `youtube_get_subscription_feed` | Newest videos from subscribed channels | None |

List tools take optional `limit` (1–100, default 50) and `cursor`;
`youtube_get_playlist_details` takes only `playlist_id`. All read tools declare
read-only, non-destructive annotations. Playlist IDs contain letters,
digits, `_` or `-`; channel IDs are `UC` plus 22 such characters. URLs and
handles are not accepted, and unknown arguments are rejected before any
request.

```json
{ "name": "youtube_get_playlist", "arguments": { "playlist_id": "WL", "limit": 20 } }
```

### Results

[Validated examples](examples/results.json) cover every list tool. Successful
responses carry identical JSON in `structuredContent` and the text block:

- `account_id`: the verified, pinned channel ID of the account.
- `items`: ordered summaries, including repeats and explicit placeholders.
- `next_cursor`: opaque in-process cursor or `null`; `has_more` mirrors it.

| Tool | Item fields |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `youtube_list_playlists` | `playlist_id`, `title`, `video_count` |
| video lists | `video_id`, `title`, `url`, `channel_name`, `availability`, `watched_percent`, `duration_seconds` |
| `youtube_get_watch_history` | video fields plus `watched_at`, `group_label` |
| `youtube_get_channel_videos` | video fields plus `published_text`; `channel_name` is `null` |
| `youtube_get_subscription_feed` | video fields plus `published_text`, `channel_id`, `is_upcoming` |
| `youtube_list_subscriptions` | `channel_id`, `title`, `handle`, `subscriber_count_text`, `notification` |

- `availability`: `available`, `private`, `deleted`, `unavailable` or `null`.

- `watched_percent`: the 0–100 progress shown on the thumbnail, or `null` when
  none is shown (unwatched or unknown; never `0`).

- `duration_seconds`: from the exact length or an `H:MM:SS`/`M:SS` label; live
  streams, Shorts and anything that is not an exact clock report `null`.

- `watched_at` is always `null`: history carries no exact timestamps.
  Relative labels such as `Today` stay in `group_label`.

- `published_text`: YouTube's relative upload label, such as `2 days ago`.
  `youtube_get_playlist_details` returns `{ account_id, playlist_id, title, description, privacy }` without items or cursor. `description` is `null` when
  the playlist has none; `privacy` is `private`, `unlisted` or `public` from the
  page header's exact label, or `null` when there is not exactly one. Only the
  account's own playlists carry that label; system lists such as `WL` and `LL`
  and playlists saved from other channels read as `null`.

- The subscription feed lists the chronological feed only; YouTube's "Most
  relevant" and Shorts shelves on its first page are skipped. `channel_id` is
  `null` for collaborations, which name several channels. Every feed answer
  tells the web client to clear the Subscriptions "new videos" dot, so reading
  the feed may clear it.

- `handle` is the `@name`; `subscriber_count_text` is shown as YouTube displays
  it; `notification` is `all`, `personalized` or `none`, read from the icon of
  the channel's current bell state.

Unknown values are `null`, never guessed from display text. Explicit private
or deleted entries stay in the list. YouTube may hide unavailable items; this
server cannot recover them. An unsupported response is an error, not an empty
success. An unknown channel ID returns `CHANNEL_UNAVAILABLE`; a channel
without a Videos tab (no regular uploads, for example only Shorts) reads as an
empty list.

### Pagination

Use [examples/walk.ts](examples/walk.ts) with an initialized MCP SDK client:

```ts
for await (const page of walk(client, "youtube_get_watch_later", { limit: 20 })) {
  consume(page.items);
}
```

Keep tool, target ID and limit unchanged when passing `next_cursor`. Replaying a
still-valid cursor returns the same page. Empty `items` with a non-null cursor
is valid: follow the cursor. The server makes at most three additional upstream
requests per page.

Cursors last at most five minutes and exist only in this process, limited to
128 cursors and 16 MiB of retained data, evicted by LRU. Session refresh,
restart and eviction produce `CURSOR_EXPIRED`: discard the partial result and
start without a cursor. This is not a snapshot; concurrent edits may reorder
entries between pages.

## Writes

`YOUTUBE_WRITES` is a comma-separated subset of `playlist`, `rating`,
`subscription` and `notification`, or `all` on its own. Unset or empty keeps
the server read-only. Anything else, including `all` beside a group name,
refuses to start with `INVALID_WRITES`, so a typo cannot silently enable or
drop a group. A tool whose group is off is neither listed nor callable.

| Group | Tool | Input | Destructive |
| -------------- | ----------------------------------- | -------------------------------------------------------------------- | ----------- |
| `playlist` | `youtube_create_playlist` | `title` (1–150), optional `privacy` (`PRIVATE` default, `UNLISTED`, `PUBLIC`), `description` (≤5000) | No |
| `playlist` | `youtube_delete_playlist` | `playlist_id` (`PL…`) | Yes |
| `playlist` | `youtube_add_to_playlist` | `playlist_id` (`PL…` or `WL`), `video_ids` (1–50, unique) | No |
| `playlist` | `youtube_remove_from_playlist` | `playlist_id` (`PL…` or `WL`), `video_ids` (1–50, unique) | Yes |
| `playlist` | `youtube_update_playlist` | `playlist_id` (`PL…`), any of `title`, `description`, `privacy` | No |
| `playlist` | `youtube_move_in_playlist` | `playlist_id` (`PL…` or `WL`), `video_id`, one of `after_video_id` or `before_video_id` | No |
| `rating` | `youtube_like_video` | `video_id` | No |
| `rating` | `youtube_remove_rating` | `video_id` | Yes |
| `subscription` | `youtube_subscribe` | `channel_id` | No |
| `subscription` | `youtube_unsubscribe` | `channel_id` | Yes |
| `notification` | `youtube_set_channel_notifications` | `channel_id`, `setting` (`all`, `personalized`, `none`) | No |

Liked videos (`LL`), mixes and uploads lists are not editable as playlists;
likes change through the rating tools. There are no dislike or comment tools.

### How a write behaves

Each write tool's description states its own caveats, because some clients
(Hermes 0.23) pass only tool descriptions and error messages to the model.
The server's MCP `instructions` summarize the same rules for clients that
read them.

- **Sent once.** A write is never retried, not even after an authentication
  failure, and every write uses the same pinned account as reads.

- **Confirmed by YouTube's answer, not by the HTTP status.** A write succeeds
  only when the response proves the requested change:

  | Tool | Required in the response |
  | ------------------------------------ | ----------------------------------------------------------------- |
  | create | a new `PL` playlist ID |
  | add, remove, update, move | `status: STATUS_SUCCEEDED` |
  | like, remove rating | the video's new like status, `LIKE` or `INDIFFERENT` |
  | subscribe, unsubscribe | a subscribe-button update for that channel with the new state |
  | notification bell | the channel's new notification state |
  | delete | a successful response (YouTube returns no further detail) |

- **`WRITE_OUTCOME_UNKNOWN`.** If a write was sent and YouTube did not refuse
  it with a 4xx status, any other ending (timeout, client cancellation,
  dropped connection, 5xx, or an answer without the confirmation above) is
  reported as unknown. The change may have happened: read the target before
  trying again.

- **Checked before sending.** A move first reads the whole playlist (at most 60
  pages) to find each entry's set ID and refuses with
  `PLAYLIST_ITEM_NOT_FOUND`, `PLAYLIST_ITEM_AMBIGUOUS` (the video is listed more
  than once) or `PLAYLIST_TOO_LONG` without sending anything. A bell change
  first finds the channel in the subscription list and refuses with
  `CHANNEL_NOT_SUBSCRIBED`; it then posts the params YouTube offers in that
  channel's own bell menu.

- **Removal is by video ID** and removes every entry of that video in the
  playlist, including duplicates. A move names the video to follow
  (`after_video_id`) or to precede (`before_video_id`); passing the current
  first video as `before_video_id` moves to the top.

- **Results** name the target and the new state, for example
  `{ "account_id", "playlist_id", "video_ids" }` or
  `{ "account_id", "channel_id", "notification" }`.

### Read-after-write delay

YouTube applies a confirmed write before its lists show it. Observed delays
until a read reflected the change:

| Change | Delay |
| ------------------------------------------------------ | ------------ |
| playlist created, renamed or edited (ordinary playlist) | about 0.2–3.5 s |
| Watch Later add, remove or move | about 11–16 s |
| like or rating removed, in liked videos | about 3–6 s |
| subscribe, unsubscribe, bell, in subscriptions | about 6 s |

A newly created playlist may briefly read as `PLAYLIST_UNAVAILABLE`, then as
empty.

## Errors

Failures return `isError: true` with a text block holding JSON
`{ "code", "message" }`. Raw upstream errors are never returned. Requests
running past 30 seconds return `TIMEOUT` (writes: `WRITE_OUTCOME_UNKNOWN` once
sent).

| Code | Meaning and what to do |
| ------------------------- | ---------------------------------------------------------------------------- |
| `BROWSER_UNAVAILABLE` | CDP is unreachable or has no default-context page. Check the browser. |
| `AUTH_REQUIRED` | Not signed in, or YouTube refused the session. Sign in in the browser. |
| `ACCOUNT_CHANGED` | The browser now holds another account. Confirm it and restart the server. |
| `CURSOR_INVALID` | The cursor does not belong to this tool, target and limit. |
| `CURSOR_EXPIRED` | The cursor's session ended. Start again without a cursor. |
| `PLAYLIST_UNAVAILABLE` | The playlist does not exist or this account cannot use it. |
| `PLAYLIST_ITEM_NOT_FOUND` | A video to move is not in the playlist. Nothing was sent. |
| `PLAYLIST_ITEM_AMBIGUOUS` | A video to move is listed twice. Nothing was sent. |
| `PLAYLIST_TOO_LONG` | The playlist exceeds 60 pages for a move. Nothing was sent. |
| `CHANNEL_UNAVAILABLE` | The channel does not exist or is unavailable. |
| `CHANNEL_NOT_SUBSCRIBED` | A bell change for a channel the account does not follow. Nothing was sent. |
| `RATE_LIMITED` | YouTube rate limited the request. Wait. |
| `UPSTREAM_BLOCKED` | YouTube asked for a bot check. Stop and check the browser. |
| `UPSTREAM_CHANGED` | YouTube answered in a shape this server does not support. |
| `UPSTREAM_UNAVAILABLE` | YouTube or the network failed, or the request was cancelled before sending. |
| `TIMEOUT` | A read took longer than 30 seconds. |
| `WRITE_OUTCOME_UNKNOWN` | A sent write may or may not have applied. Read the target before retrying. |

## Browser session boundary

Authentication is lazy: the first call reads cookies from an existing page in
the browser's default context over CDP. Only cookies applicable to
`https://www.youtube.com/` enter the in-memory YouTube.js session. No cookie
file, profile database or disk cache is used, and no page JavaScript runs.

Only HTTP(S) CDP origins are accepted; credentials, path prefixes, query
strings and fragments are rejected. Tools cannot override the endpoint. CDP
discovery redirects are rejected and the WebSocket authority is checked. Run
the server on the browser's host so CDP stays on loopback, or reach a remote
browser through an operator-managed SSH tunnel. Never expose CDP: it grants
full control of the browser.

On `AUTH_REQUIRED`, sign into the intended YouTube account in the browser and
keep a default-context page open. There is no automatic login, tab creation,
navigation or account switching. A stable channel ID must be readable; missing
or ambiguous identity fails closed. Snapshots last at most five minutes; a
clear authentication failure on a read causes at most one reacquisition.

Every authenticated request names the routes it may reach, and the transport
compares the whole request path against them: reads may reach only `browse`,
and each write tool only its own route (plus `browse` for the reads a move or
bell change needs). Requests to any other path never leave the process.
Cookie strings and client objects live only in process memory; JavaScript
cannot guarantee zeroization, so protect process memory and core dumps with
deployment controls. CDP and Google cookies grant more than this server's
tools; restricting the tools does not reduce those privileges.

## Tests and live checks

`bun run test` runs the protocol suite against local fixtures: a real Bun
subprocess and MCP client for discovery and shutdown, in-process sessions for
schema rejection, errors, deadlines and cancellation, HTTP fail-closed paths,
and every write tool's input checks, request bodies, confirmation rules and
`WRITE_OUTCOME_UNKNOWN` paths. No test touches a browser or account. The flake
checks also build the package with tests, the flakelet units, and a NixOS VM
test of the HTTP service.

Live checks need the account owner's explicit approval each time. The
read-only smoke check reads five items per list tool over stdio, then the
details of a playlist found on the way, and prints only counts, null fields,
codes and timings:

```sh
YOUTUBE_LIVE_READONLY=1 YOUTUBE_CDP_URL=http://127.0.0.1:9222 bun run test:live
```

Without the opt-in it exits before contacting CDP. Write checks are run as
throwaway probes that work in a new private playlist, or on a video, channel
or setting chosen so the account ends as it started; they print flags,
counts and timings only. [VERIFICATION.md](VERIFICATION.md) records each run.

## Verification status

All 20 tools were checked live on one account on 2026-11-10 and 2026-11-11.

| Area | Checked live | Not checked live |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| reads | five items per tool; full paging of Watch Later, playlists, subscriptions; new fields populated; unknown and upload-less channels; every list on an empty account | — |
| playlists | create (private; unlisted with description, both read back), delete, add/remove 1–50 videos, rename, privacy changes read back, move (including to the top) in a playlist and in Watch Later, not-found and duplicate refusals | creating a playlist as public in one call, `PLAYLIST_TOO_LONG` |
| ratings | like and removal on a video that was not liked | removing a dislike |
| subscriptions | subscribe and unsubscribe a channel that was not followed | — |
| bells | all, none and personalized on one channel; refusal for an unfollowed channel | — |
| transports | reads over stdio and HTTP; every write group over stdio; playlist writes over HTTP | a reverse proxy in front of HTTP |
| failure paths | `WRITE_OUTCOME_UNKNOWN` for a create whose answer was dropped and an add held past the deadline, both applied by YouTube | 5xx answers and refusals from YouTube on a live write; other accounts and layouts |

Fixture tests cover the unchecked failure paths. A passing check shows the
account's current responses matched; YouTube can change them, and unknown
shapes fail closed.

## Logging

`YOUTUBE_LOG_LEVEL` selects `error`, `warn`, `info` (default) or `debug`.
Records are JSONL on stderr with `schema_version: 1`, UTC `timestamp`, `level`
and a fixed `event`. Fields are limited to generated correlation IDs, fixed
stage, tool and result names, limits, counts, durations, cache states and safe
error codes. Cookies, tokens, CDP URLs, account, video, playlist and channel
IDs, titles, cursors and raw requests or responses are never logged, nor are
their hashes. Requested results stay on stdout (stdio) or in the HTTP body.

| Event | Level | Content |
| --------------------------- | ---------- | -------------------------------------------------------------- |
| `server.start` | info | enabled write groups, if any |
| `server.stop` | info | `SIGINT`, `SIGTERM` or `transport_closed` |
| `server.fatal` | error | fixed code `PROCESS_FAILURE` |
| `config.invalid` | error | configuration code |
| `http.rejected` | warn | HTTP status |
| `request.end` | info, warn | tool, `limit` for reads, outcome, safe code, duration, cache states |
| `logs.dropped` | warn | count of records lost to backpressure |
| `stage.start`/`stage.end` | debug | stage boundaries, see below |

The writer keeps at most 256 records or 256 KiB pending; on saturation new
records are dropped and later counted in `logs.dropped`. A broken sink
disables diagnostics without recursion, and closing waits at most one second.
This is not a lossless audit log; capture, rotation and retention belong to
the operator. Shutdown paths share one idempotent `server.stop`.

`request.end` timing starts after input validation and ends when the result or
safe failure is decided; it excludes serialization, transport and startup. At
debug, stages mark these inclusive boundaries:

| Stage | Meaning |
| ------------------ | ----------------------------------------------------- |
| `auth.wait` | Snapshot acquisition or waiting on a shared refresh |
| `auth.refresh` | One shared authentication acquisition |
| `cdp.connect` | Discovery HTTP and WebSocket connection |
| `cdp.cookies` | Default-context selection, cookie read, and detach |
| `auth.identity` | Client creation and stable account verification |
| `upstream.request` | Browse execution through body consumption and parsing |
| `normalize` | Local page normalization |
| `pagination` | Page assembly, cursor management, and nested waits |

Nested stage durations are inclusive; do not add them. A shared
authentication has its own `refresh_id`, linked from each waiting request.
`auth_cache` is `hit`, `miss`, `shared` or `mixed`; `page_cache` is `miss`,
`buffer`, `replay` or `shared`, omitted when not reached. Do not enable
upstream verbose logging: it can expose session material.

## External latency verification

Use an existing MCP client and collect stderr separately; there is no
benchmark command. `test:live` is a smoke check, not this procedure.

1. Obtain fresh account-owner approval for tools, limits, conditions, repeats,
   preparation reads and the time budget. Use local fixtures otherwise.
1. Fix the tool, input limit, environment and log level. Run sequentially and
   isolate condition logs. Default to five attempts per condition and a
   five-minute total budget including preparation and startup; cancel the
   current request when the budget expires.
1. **Cold authentication:** a new MCP process per attempt; the target call is
   its first authenticated read.
1. **Warm authentication:** in one process, one preparation read, then the same
   input without a cursor five times while `auth_cache=hit`.
1. **Cursor replay:** prepare a cursor, then repeat that same cursor five times
   and confirm `page_cache=replay`. Skip with a reason if no cursor exists.
1. Stop on `AUTH_REQUIRED`, `ACCOUNT_CHANGED`, `UPSTREAM_BLOCKED` or
   `RATE_LIMITED`. Record other failures separately within the budget.
1. Report successful samples, median, min and max, failures with codes, skips
   and missing diagnostics. With no samples report **N/A**. Keep server
   duration, client round-trip and startup in separate columns; never persist
   IDs, titles or cursors, and never count missing logs as zero-duration calls.

Debug tracing adds overhead; state the level with results. Do not derive p95
from these samples or impose a fixed SLO. See
[VERIFICATION.md](VERIFICATION.md#external-measurement-record-template) for the
reporting template.
