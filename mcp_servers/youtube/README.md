# YouTube MCP

Read-only YouTube MCP server using Bun and TypeScript.

Read-only tools are connected to the CDP session provider, YouTube.js
adapter, normalization, and bounded pagination. The server speaks MCP over
stdio or authenticated HTTP. Discovery is credential free; actual reads
authenticate lazily. Local integration tests pass. Approved live checks over
both transports returned five items from each of the first five tools on one
account; tools added later await their own approved live check;
see [VERIFICATION.md](VERIFICATION.md) for scope and remaining limits.

## Development

From the repository root:

```sh
nix develop .#youtube
cd mcp_servers/youtube
bun install --frozen-lockfile
bun run check
```

`bun run format` formats TypeScript and JSON in this package. Run `nix fmt`
from the repository root for Markdown and the other repository formats.
Markdown has one formatter (mdformat), so Prettier does not rewrite it.
TypeScript is checked separately with
`bun run typecheck`; Bun execution alone does not type-check TypeScript.
Runtime and development dependencies are pinned in `package.json` and `bun.lock`.
`nix develop` and `nix develop .#youtube` provide the same Bun shell.

## Run over stdio

From `mcp_servers/youtube`, run:

```sh
bun run start
```

Connect an MCP client rather than typing interactive commands. Configure the
client command as `bun`, arguments as `run src/index.ts`, and working directory
as the absolute path to `mcp_servers/youtube`. Stdout contains only MCP protocol
messages; diagnostics must go to stderr without session details.

Tool discovery does not require a running browser or credentials.

## Run over HTTP

Set `YOUTUBE_TRANSPORT=http` to serve stateless Streamable HTTP at `/mcp`:

```sh
YOUTUBE_TRANSPORT=http \
YOUTUBE_HTTP_PORT=8765 \
YOUTUBE_HTTP_TOKEN_FILE=/run/credentials/youtube-mcp/token \
bun run start
```

| Variable | Default | Meaning |
| ---------------------------- | --------------------- | -------------------------------------------- |
| `YOUTUBE_HTTP_PORT` | required | TCP port, 1–65535 |
| `YOUTUBE_HTTP_TOKEN_FILE` | required | File holding the bearer token on one line |
| `YOUTUBE_HTTP_HOST` | `127.0.0.1` | Listen address |
| `YOUTUBE_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted in `Host` |

The token must be at least 32 visible ASCII characters with no whitespace;
one trailing newline is ignored. Generate it with `openssl rand -hex 32`.
Invalid or incomplete configuration logs `config.invalid` and exits 1 before
listening.

Each request is checked in this order: `Host` hostname against the allowlist
(403), `Authorization: Bearer` with a constant-time comparison (401), path
`/mcp` (404), and method `POST` (405). Rejections log `http.rejected` with the
status only. `Host` is matched by hostname without the port, so a reverse
proxy that keeps the original host passes unchanged. Keep the listener on
loopback and put TLS in front; the server itself speaks plain HTTP.

Every request gets a fresh MCP server, and all requests share one reader, so
concurrent clients share one browser refresh and one cursor store. Cursors
work across clients but compete for the same 128-entry limit, and an
authentication failure in any request expires every outstanding cursor.

Client configuration (Claude Code):

```json
{
  "type": "http",
  "url": "https://youtube-mcp.example/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

## Tools

| Tool | Purpose | Required input |
| --------------------------- | ----------------- | -------------- |
| `youtube_list_playlists` | Account playlists | None |
| `youtube_get_playlist` | Playlist contents | `playlist_id` |
| `youtube_get_watch_later` | Watch Later | None |
| `youtube_get_liked_videos` | Liked videos | None |
| `youtube_get_watch_history` | Watch history | None |
| `youtube_list_subscriptions` | Subscribed channels | None |
| `youtube_get_channel_videos` | A channel's uploads, newest first | `channel_id` |

All tools accept optional `limit` (integer 1–100, default 50) and `cursor`.
Playlist IDs contain letters, digits, `_`, or `-`; URLs are not accepted.
Channel IDs are `UC` plus 22 such characters; handles and URLs are not accepted.
Unknown arguments are rejected before backend access. All tools declare
read-only, non-destructive annotations. No write or arbitrary API tools exist.

`YOUTUBE_WRITES` selects write tool groups: a comma-separated subset of
`playlist`, `rating`, `subscription` and `notification`, or `all` on its own.
Unset or empty keeps the server read-only. Any other value, including `all`
beside a group name, refuses to start with `INVALID_WRITES`, so a typo cannot
silently enable or drop a group. `server.start` lists the enabled groups. The
flakelet module exposes the same list as `writes`.

| Group | Tool | Input | Destructive |
| ---------- | ------------------------- | ------------------------------------------------------- | ----------- |
| `playlist` | `youtube_create_playlist` | `title`, optional `privacy` (default `PRIVATE`), `description` | No |
| `playlist` | `youtube_delete_playlist` | `playlist_id` (`PL…` only) | Yes |
| `playlist` | `youtube_add_to_playlist` | `playlist_id` (`PL…` or `WL`), `video_ids` (1–50, unique) | No |
| `playlist` | `youtube_remove_from_playlist` | `playlist_id` (`PL…` or `WL`), `video_ids` (1–50, unique) | Yes |
| `playlist` | `youtube_update_playlist` | `playlist_id` (`PL…`), `title` and/or `description` | No |
| `playlist` | `youtube_move_in_playlist` | `playlist_id` (`PL…` or `WL`), `video_id`, `after_video_id` | No |

Write tools declare `readOnlyHint: false` and `idempotentHint: false`; deletes
also declare `destructiveHint: true`. A write is sent once and never retried.
If it was sent and YouTube did not refuse it with a client error, any later
failure (timeout, dropped connection, server error, or a response without the
expected fields) returns `WRITE_OUTCOME_UNKNOWN`: read the target before trying
again. Diagnostics record the tool and outcome, never the IDs or titles.
Adding and removing send one `browse/edit_playlist` request with an action per
video; removal is by video ID, so the playlist is not read first. An edit
counts as done only when YouTube answers `STATUS_SUCCEEDED`. A move needs
each entry's set ID, so it first reads the playlist to its end, at most 60
pages; it refuses with `PLAYLIST_ITEM_NOT_FOUND`, `PLAYLIST_ITEM_AMBIGUOUS` (a
video listed twice) or `PLAYLIST_TOO_LONG` before sending anything. Moving to
the very top is not supported.

Example MCP call arguments:

```json
{
  "name": "youtube_get_playlist",
  "arguments": { "playlist_id": "WL", "limit": 20 }
}
```

Execution failures use `isError: true` with a text content block containing
JSON with safe `code` and `message` fields. Raw upstream exceptions are never
returned. Client cancellation aborts the operation; requests exceeding 30
seconds return `TIMEOUT` and abort their backend signal.

## Results

[Validated examples](examples/results.json) cover every tool. Successful
responses contain identical JSON in `structuredContent` and text content:

- `account_id`: verified, pinned channel ID, not a display name or email.
- `items`: ordered summaries, including repeats and explicit placeholders.
- `next_cursor`: opaque in-process cursor or `null`.
- `has_more`: whether `next_cursor` is non-null.

`youtube_list_playlists` returns `playlist_id`, `title`, and `video_count`.
All other tools return `video_id`, `title`, `url`, `channel_name`, and
`availability` (`available`, `private`, `deleted`, `unavailable`, or `null`),
and `watched_percent`: the 0–100 progress YouTube shows on the thumbnail, or
`null` when it shows none (unwatched or unknown; never reported as `0`), and
`duration_seconds`, read from the exact length or a `H:MM:SS`/`M:SS` label;
live streams, Shorts and anything else that is not an exact clock report `null`.
`youtube_get_watch_history` additionally returns `watched_at` and `group_label`.
`youtube_list_subscriptions` returns `channel_id`, `title`, `handle` (`@name`),
`subscriber_count_text` as YouTube displays it, and `notification` (`all`,
`personalized`, or `none`), the bell setting read from the icon of the
channel's current notification state.
`youtube_get_channel_videos` returns the video fields with `channel_name` set to
`null` (the channel is the requested one) plus `published_text`, YouTube's
relative upload label such as `2 days ago`. An unknown or removed channel ID
has no verified response shape yet and fails as an upstream error.
Current supported history structures do not provide exact watch timestamps:
`watched_at` is `null`. Relative labels such as `Today` stay in `group_label`.

Unknown values are `null`, never guessed from display text. Explicit private
or deleted entries remain in the list. YouTube may hide unavailable items
entirely; this server cannot recover them or promise a complete archive.
An unsupported response is an error, not an empty success.

## Pagination

Use [examples/walk.ts](examples/walk.ts) with an initialized MCP SDK client:

```ts
for await (const page of walk(client, "youtube_get_watch_later", {
  limit: 20,
})) {
  consume(page.items);
}
```

This is explicit client-side iteration, not automatic server-side traversal.
Keep tool, playlist ID, and limit unchanged when passing `next_cursor`.
Replaying a still-valid cursor returns the same page. Empty `items` with a
non-null cursor is valid: follow that cursor instead of assuming completion.
The server makes at most three additional upstream requests per page.

Cursors last at most five minutes and exist only in this process. State is
limited to 128 cursors and 16 MiB of serialized retained data, evicted by LRU.
Session refresh, restart, and eviction produce `CURSOR_EXPIRED`. Discard the
incomplete accumulation and start without a cursor; never silently append a
restarted traversal to old results. `examples/walk.ts` surfaces expiry rather
than automatically restarting. The local MCP fixture test runs both traversal
and explicit recovery.

This is not an immutable snapshot. Browser/account changes can invalidate
cursors, and concurrent YouTube edits may change ordering between requests.
The server preserves duplicates and source order; it cannot repair remote
changes or reconstruct entries YouTube never returned.

## Tests

```sh
bun run test
```

The protocol suite starts a real Bun subprocess and MCP client to check
initialization, discovery, error responses, and shutdown without a browser.
In-process MCP sessions exercise schema rejection, secret-safe errors,
deadlines, and cancellation. HTTP tests cover every fail-closed path
(credentials, Host, path, method, configuration) and check that concurrent
clients share one browser refresh and cursor computation. These tests do not access a personal account.

## Browser session boundary

Authentication is lazy: the first read acquires
cookies from an existing page in the browser's default context over CDP.
Only cookies applicable to `https://www.youtube.com/` enter the in-memory
YouTube.js session. No cookie file, profile database, or disk authentication
cache is used. HttpOnly cookies are supported without executing page JavaScript.

Operator configuration:

```sh
YOUTUBE_CDP_URL=http://127.0.0.1:9222 bun run start
```

Only HTTP(S) origins are accepted; credentials, path prefixes, query strings,
and fragments are rejected. Tools cannot override the endpoint. CDP discovery
redirects are rejected and WebSocket authority is checked. See [UPSTREAM.md](UPSTREAM.md).

Any Chromium-based browser with remote debugging enabled works. Run the
server on the browser's host so CDP stays on loopback, or reach a remote
browser through an operator-managed SSH tunnel. This package does not create
tunnels, change firewall rules, or manage the browser; the HTTP listener is
the only port it opens. Never expose CDP publicly: it grants full control of
the browser, not only cookie reads.

On `AUTH_REQUIRED`, open the browser manually and sign into the intended default
YouTube account. Keep an existing default-context page open. There is no
automatic login, tab creation, navigation, or account switching. A stable
channel ID must be readable; missing/ambiguous identity fails closed.

Snapshots last at most five minutes. Concurrent acquisition is shared; a clear
authentication failure causes at most one reacquisition and first-page retry.
A changed account permanently yields `ACCOUNT_CHANGED`: confirm the account
and restart MCP to accept it. Continuations expire when sessions change and
must be restarted without a cursor. Rate limits and generic permission failures
do not trigger authentication retries.

Cookie strings and authenticated client objects live only in process memory.
JavaScript does not guarantee string zeroization. Protect process memory and
core dumps using deployment controls. CDP and Google cookies themselves grant
more than read access; restricting this MCP's commands does not reduce those
underlying privileges. No raw CDP/API or mutating tools are exposed.

## Opt-in live read check

Do not run this without the account owner's explicit approval. After logging
into YouTube in the browser, run the check through the actual stdio MCP client. It
requests five items per tool, chooses a playlist ID from the first response
(or WL if none is listed), and checks account consistency across responses.
No manual channel or playlist ID is required. Short lists may return fewer
than five items. It prints only counts, safe error codes, timings, stderr byte count, and a
safe diagnostic-validation summary, never titles, IDs, cookies, or raw server
diagnostics. Valid nonempty JSONL is expected, not a failure. The checker
rejects malformed, oversized, truncated, or non-allowlisted diagnostics using
a bounded incremental parser. `YOUTUBE_LOG_LEVEL` is forwarded to the child.
This remains a five-tool smoke check, not a performance benchmark.

```sh
YOUTUBE_LIVE_READONLY=1 \
YOUTUBE_CDP_URL=http://127.0.0.1:9222 \
bun run test:live
```

Without opt-in the command exits before loading the reader or contacting CDP.
`test:live` drives the stdio transport; the HTTP check used a throwaway
JSON-RPC client with the same output limits.
It is not a `*.test.ts` file and is excluded from the default test command.
The default suite uses local protocol fixtures, not a browser or YouTube.
See [VERIFICATION.md](VERIFICATION.md) for recorded verification limits.

## Logging and audit

### Structured diagnostic contract

The server accepts `YOUTUBE_LOG_LEVEL=error|warn|info|debug`, with `info` as
the default. Empty or unknown values stop startup without printing their
contents or contacting CDP. There is no separate `YOUTUBE_DEBUG` flag.
This contract does not enable upstream logs.

Records use JSONL with `schema_version: 1`, UTC `timestamp`, `level`, and a
fixed `event`. Permitted data is limited to internally generated correlation
IDs, fixed stage/tool/result names, validated limits, counts, finite durations,
cache states, and safe error codes. Unknown fields are discarded; invalid
records are omitted rather than printed as raw diagnostic failures.
Cookies, authorization headers, CDP URLs, account/video/playlist IDs, titles,
cursors, raw arguments/responses/exceptions, and hashes of those values are
never diagnostic fields. Requested MCP results remain on protocol stdout.

The writer retains at most 256 outstanding records or 256 KiB of UTF-8 JSONL,
including newlines and writes pending inside the stream. New records are
lost on saturation; after successful output resumes, `logs.dropped` reports
unreported losses at warn level (filtered when configured at error).
A broken sink disables diagnostic output without recursive error logging.
Closing the writer waits at most one second. This is not lossless auditing:
forced termination, broken stderr, and saturation can lose records, including
completion and shutdown events. File capture, rotation, and retention belong
to the operator, not this server.

Startup emits `server.start` at info. SIGINT, SIGTERM, stdin EOF, and transport
closure share an idempotent shutdown path: `server.stop` at info, then at most
one second of diagnostic flushing. Repeated signals do not duplicate the stop
event. A broken stderr cannot prevent exit; forced termination can lose all
pending records. Unexpected process failures emit
`server.fatal` at error with a fixed safe code rather than an exception or
stack. Stderr is no longer normally empty. Stdout remains reserved for MCP
messages, including requested results. YouTube.js logging stays disabled.
Each validated tool execution emits one `request.end` with a generated
`request_id`, tool name, limit, result, and monotonic `duration_ms`. Success
is info with returned count; errors, timeouts, and cancellations are warn with
safe codes. Timeout/cancellation summaries retain the active stage snapshot;
normal cleanup aborts are not cancellations, and late work cannot publish a
second completion. Ordinary tool failures keep their existing MCP codes.

Timing starts after SDK input validation and ends when the operation's result
or safe failure is decided. It excludes MCP serialization/transmission, client
round-trip, process startup, discovery, and rejected inputs. Measure those
externally rather than interpreting server duration as end-to-end latency.
At debug, `stage.start`/`stage.end` identify these boundaries:

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

Stage IDs and parent IDs describe nested **inclusive** durations; do not add
nested or overlapping times to obtain total request time. Shared authentication
has its own `refresh_id`, linked from each waiting request. Cancelling one
waiter does not mark another waiter or the shared refresh as cancelled.
These are local boundaries, not profiling inside YouTube or arbitrary source
lines. Logging may lose events under backpressure, so a missing end event is
not proof that work is still running.

`auth_cache` distinguishes `hit`, `miss`, and `shared`; `mixed` means a request
crossed states, such as reuse followed by reacquisition. `page_cache` is `miss`
when upstream work is needed, `buffer` when retained items suffice, `replay`
for a completed cursor result, or `shared` for another request's pending
calculation. Cache fields are omitted when execution never reaches the relevant
boundary. Replays and waiters do not fabricate upstream spans or log cursors.

The opt-in check's summary is test evidence, not a production audit trail.
Durable storage and retention are not provided. Do not enable upstream verbose
logging as a substitute: it can expose session material.

## External latency verification

Use an existing MCP client and collect stderr separately. There is no new
benchmark command, background workload, or automatic performance verdict.
The five-tool `test:live` command is a smoke check, not this procedure.

1. Obtain fresh account-owner approval for tools, limits, conditions, repeats,
   preparation reads, and the time budget before touching a real account.
   Previous five-item approval is not permission for repeated measurements.
   Use local fixtures when approval is absent.
1. Fix the tool, input limit, environment, and log level. Run sequentially,
   without unrelated calls, and isolate condition logs. Default to five
   **attempts per condition** and a **five-minute total budget**, including
   preparation and process startup. The external client cancels the current
   request when the remaining budget expires and starts no further requests.
1. **Cold authentication:** use a new MCP process for every measured attempt;
   the target call must be its first authenticated read. This does not reset
   browser, OS, or YouTube caches. If playlist selection needs a preparation
   read, obtain the ID beforehand and retain it only in client memory.
1. **Warm authentication:** in one process, perform a preparation read, then
   repeat the same input **without a cursor** five times while its snapshot
   remains valid. Confirm `auth_cache=hit`; refresh/mixed cases do not count
   as warm samples.
1. **Cursor replay:** obtain a cursor, call it once to prepare its result, then
   repeat that **same cursor**, tool, playlist, and limit five times. Do not
   advance to the returned next cursor. Confirm `page_cache=replay`. If no
   cursor exists, skip with a reason. Expiry or refresh invalidates the
   condition; do not silently restart and label new work as replay.
1. Stop the entire procedure immediately on `AUTH_REQUIRED`, `ACCOUNT_CHANGED`,
   `UPSTREAM_BLOCKED`, or `RATE_LIMITED`, including during preparation.
   Record other errors/timeouts separately and continue within the remaining
   budget. If preparation cannot establish a condition, skip that condition
   with a reason rather than inventing samples.
1. Exclude preparation from latency statistics but count it in request totals
   and budget. Report successful sample count, median/min/max, failure count
   and safe codes, skipped conditions, missing diagnostics, and any stop
   reason. With zero successful samples, report latency as **N/A**, not zero.
   Keep server duration, externally measured client round-trip, and process
   startup times in separate columns. Do not persist IDs, titles, or cursors.
1. Generated request IDs identify server trace trees, not client request IDs.
   Sequential call order helps map complete logs, but losses can make matching
   ambiguous. Mark such measurements unavailable rather than guessing which
   completion belongs to which attempt. Never count missing logs as successful
   zero-duration calls or as confirmed query failures.

Debug tracing changes measurement overhead. State the level and collector
conditions with results. Do not compute p95 from these small samples, impose a
fixed SLO, or automatically label a delay as an architecture versus implementation
problem. Review evidence first; the user sets subsequent performance criteria.
See [VERIFICATION.md](VERIFICATION.md#external-measurement-record-template)
for the reporting template and an explicitly synthetic arithmetic example.

## Verification boundary

Local integration covers stdio through HTTP/WebSocket CDP and upstream
fixtures, including cancellation, timeout, account changes, and secret-safe
failures. This is not proof that a personal account's current YouTube response
matches those fixtures. Unsupported structures fail closed.

The HTTP transport is verified locally and in one live check; deployment
behind a reverse proxy and all writes are separate changes. Nix packaging
lives in `nix/youtube.nix`. Live read-only testing requires explicit approval and is not part
of the default suite.
