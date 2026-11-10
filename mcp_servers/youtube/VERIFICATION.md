# Verification record

## Approved live rating check: 2026-11-10

With `YOUTUBE_WRITES=rating`, a public upload absent from the account's 3,128
liked videos was liked (returned `rating: like`, at the top of liked videos
after about 3.0 s) and its rating removed (gone after about 5.5 s). Afterwards
the full liked list matched the original entries and order. Two earlier
key-only probes established the request body and the `likeStatusEntity`
confirmation and also restored the original state.

## Approved live playlist update and move check: 2026-11-10

In a new private playlist holding three public uploads, renaming (with a
description) showed the new title in `youtube_list_playlists` after about
0.2 s, and moving the first video after the third gave the expected order
after about 2.3 s; the playlist was then deleted. In Watch Later (2,177
entries) the sixth entry was moved two places down (visible after about
11.1 s) and then back after its original predecessor; after about 11.9 s the
whole list matched its original order. Every write returned success; only
flags and timings were printed.

## Approved live playlist edit check: 2026-11-10

With `YOUTUBE_WRITES=playlist`, two public uploads from a subscribed channel
that were not in Watch Later were used. In a new private playlist, adding both
was visible after about 2.4 s, removing one left exactly the other after about
2.4 s, and the playlist was deleted. In Watch Later (2,177 entries), adding one
of them was visible after about 12.5 s and removing it again took about 16.4 s
to show; afterwards Watch Later had the same entries in the same order as
before. Every write returned success; only flags, counts and timings were
printed.

## Approved live paging check: 2026-11-10

Reading Watch Later past its first page failed with `UPSTREAM_CHANGED`; a
key-only scan showed the continuation response carrying an empty tab shell in
`contents` beside `onResponseReceivedActions`. After the fix, paging with
`limit: 100` read Watch Later to its end (22 pages), liked videos for 30 pages
(the probe's cap), playlists (1 page) and subscriptions (4 pages) to their
ends, with no error. Only counts were printed.

## Approved live empty-playlist read: 2026-11-10

A newly created private playlist read back through `youtube_get_playlist` as
zero items with no further page about 2.3 s after creation (the first attempt,
before the playlist propagated, was refused), and was then deleted.

## Approved live playlist create/delete check: 2026-11-10

With `YOUTUBE_WRITES=playlist`, the first live create returned
`WRITE_OUTCOME_UNKNOWN` although the playlist was made: new playlist IDs are
`PL` plus 11 characters, and the ID check expected at least 16 after `PL`
(every older playlist on the account is `PL` plus 32). The tool reported the
uncertain outcome as designed; the pattern now accepts both lengths, with a
regression test. The two probe playlists left by that run were deleted with
`youtube_delete_playlist`.

After the fix, one private playlist was created, appeared in
`youtube_list_playlists` after about 3.5 s, was deleted, and was gone from the
list within 0.5 s. Reading the new, empty playlist returned `UPSTREAM_CHANGED`;
see the next entry. No playlist ID or title is stored here.

## Approved live check of write configuration: 2026-11-10

With `YOUTUBE_WRITES=all` against the same browser, `server.start` listed all
four groups, discovery still returned the seven read tools (no group has tools
yet), and a Watch Later read returned five items. `YOUTUBE_WRITES=playlists`
exited with status 1 and `INVALID_WRITES` before serving.

## Approved live check after route scoping: 2026-11-10

After authenticated requests were scoped to named routes, `bun run test:live`
against the same browser returned five items from each of the seven read
tools with one account ID and nine valid diagnostic records. Null-in-every-item
fields were unchanged: `channel_name` for history (Shorts) and channel uploads.

## Approved live duration check: 2026-11-10

The account owner asked for each change to be checked live. The stdio server
ran from the commit that introduced `duration_seconds`, with `YOUTUBE_CDP_URL=http://127.0.0.1:9222`. A
throwaway client printed only counts; no identifier, title, or response body
is stored here.

| Tool | Items | `duration_seconds` set | Positive, under 24 h |
| ---------------------------- | ----: | ---------------------: | -------------------: |
| `youtube_get_watch_later` | 20 | 20 | 20 |
| `youtube_get_liked_videos` | 20 | 20 | 20 |
| `youtube_get_channel_videos` | 20 | 20 | 20 |
| `youtube_get_watch_history` | 400 | 21 | 21 |

The first 100 history entries were all Shorts, which carry no duration. Over
four pages, 22 entries carried a channel name (regular videos); 21 of them had
a duration and progress, and no Shorts entry reported a duration. The one
regular video without a duration showed no exact clock badge.

## Approved live browse-read check: 2026-11-10

The account owner asked for a live check of the new browse reads. The stdio
server ran from commit `061fca8` with `YOUTUBE_CDP_URL=http://127.0.0.1:9222`
through `bun run test:live`, which reads five items with each tool. The
subscription read supplied the channel ID for the uploads read. Two throwaway
probes then printed only field counts and renderer key names. No cookie,
account ID, channel/playlist/video ID, title, handle, or response body is
stored here.

| Tool | Returned | More pages | Fields null in every item | Elapsed |
| ---------------------------- | -------: | ---------- | ------------------------- | ------: |
| `youtube_list_playlists` | 5 | Yes | — | 652 ms |
| `youtube_get_playlist` | 5 | Yes | — | 543 ms |
| `youtube_get_watch_later` | 5 | Yes | — | 487 ms |
| `youtube_get_liked_videos` | 5 | Yes | — | 454 ms |
| `youtube_get_watch_history` | 5 | Yes | `channel_name` | 967 ms |
| `youtube_list_subscriptions` | 5 | Yes | — | 669 ms |
| `youtube_get_channel_videos` | 5 | Yes | `channel_name` (by design) | 266 ms |

Every response carried the same account ID; nine diagnostic records were
valid.

New fields, counted over five items each:

- `watched_percent`: 3 of 5 in Watch Later, 4 of 5 in liked videos, 1 of 5 in
  channel uploads, all within 0–100. History returned 0 of 5: a key-only scan
  of its first page found 191 `shortsLockupViewModel` and 8 `lockupViewModel`
  entries, with 7 `thumbnailOverlayProgressBarViewModel` progress bars, so the
  first five entries were Shorts, which carry neither progress nor a channel.
- `youtube_list_subscriptions`: 5 of 5 handles start with `@`, 5 of 5
  subscriber labels matched, and every bell resolved (all `personalized`).
- `youtube_get_channel_videos`: 5 of 5 `published_text` labels ending in `ago`.

Not covered: an account with no subscriptions, a channel with no uploads, an
unknown channel ID, and the `all` and `none` bell icons on a live response.

## Approved live HTTP check: 2026-11-10

The account owner explicitly requested a live read of five items with each
tool over the HTTP transport. The server ran from commit `bf2da7a` on the
browser's host with `YOUTUBE_TRANSPORT=http`, a random 64-hex-character token
file, a loopback listener, and `YOUTUBE_CDP_URL=http://127.0.0.1:9222`. A
throwaway client posted JSON-RPC directly and printed only counts, flags,
timings, and error codes. As above, no cookie, token, account ID,
playlist/video ID, title, or response body is stored here.

| Request | Returned | More pages | Elapsed |
| ---------------------------------------- | -------: | ---------- | ------: |
| No `Authorization` header | 401 | — | — |
| `initialize` / `tools/list` | 5 tools | — | — |
| `youtube_list_playlists` (concurrent) | 5 | Yes | 546 ms |
| `youtube_get_watch_later` (concurrent) | 5 | Yes | 892 ms |
| `youtube_get_liked_videos` | 5 | Yes | 521 ms |
| `youtube_get_watch_history` | 5 | Yes | 928 ms |
| `youtube_get_playlist` | 5 | Yes | 429 ms |
| Watch Later cursor, two concurrent calls | 5 each | Yes | 2–3 ms |

Every successful response carried an account ID. The playlist ID came from
the first `youtube_list_playlists` result. The two cursor followers returned
byte-identical JSON-RPC responses.

Info-level diagnostics: one `server.start`, seven `request.end` (all `ok`),
two `http.rejected` with status 401 (the readiness probe and the anonymous
request), and one `server.stop` after SIGTERM. Authentication cache states
were `miss`, then `shared` for the concurrent request, then `hit` for every
later request, so CDP was used once. The cursor followers recorded page cache
`buffer` and `replay`, with no additional upstream request. The token did not
appear in diagnostics.

Not covered: a reverse proxy in front of the listener, `allowedHosts` other
than the loopback defaults, clients other than direct JSON-RPC, and
deployment as a service.

## Approved live check: 2026-10-11

The account owner explicitly approved reading five items with each tool.
The check used a real stdio MCP client and the existing local CDP tunnel.
Only summary evidence is recorded; no cookie, account ID, playlist/video ID,
title, history entry, or original response body is stored here.

| Tool | Requested | Returned | More pages | Elapsed |
| --------------------------- | --------: | -------: | ---------- | ------: |
| `youtube_list_playlists` | 5 | 5 | Yes | 807 ms |
| `youtube_get_playlist` | 5 | 5 | Yes | 550 ms |
| `youtube_get_watch_later` | 5 | 5 | Yes | 412 ms |
| `youtube_get_liked_videos` | 5 | 5 | Yes | 514 ms |
| `youtube_get_watch_history` | 5 | 5 | Yes | 900 ms |

All successful responses had the same server-verified account identity.
The playlist ID was discovered from the first tool result, not supplied by the
operator. Server stderr during the check: **0 bytes**. No account mutations,
page navigation, JavaScript evaluation, or cookie writes were performed.

The first run passed playlist discovery but rejected the other four tools with
`UPSTREAM_CHANGED`. Shape-only inspection identified continuation view models,
command-executor-wrapped continuations, and Shorts shelves missing from our
normalizer. Synthetic regression cases reproduced those failures before the
fix. The table records the subsequent successful run, not the initial failure.
The pinned dependency was not upgraded.

## Historical input and logging checks

This section and the following 60-test record describe the pre-observability
implementation. The historical zero-byte stderr result above is not an
expectation for the current default info logger.

- Omitted `limit` becomes **50** through the MCP schema; confirmed with a local
  client. Allowed range: integer 1–100. Live requests explicitly used 5.
- Every tool accepts optional `limit` and `cursor`; only
  `youtube_get_playlist` requires `playlist_id`. Unknown fields are rejected.
- Upstream pages may contain more than the requested item count. Remaining
  normalized items stay in bounded process memory rather than being dropped.
- No debug flag or persistent per-request audit logger exists. Upstream logging
  is disabled; stdout carries MCP messages and stderr only fixed fatal errors.
- Test summaries are not a production audit trail. Request attribution,
  retention, durable audit storage, and debug-mode configuration are absent.

## Historical local checks

Verified in `nix develop .#youtube`:

- `bun install --frozen-lockfile`: passed without dependency changes.
- `bun run format` and `bun run check`: passed (TypeScript and Prettier).
- `bun run test`: **60 passed, 0 failed**, across 16 protocol test files.
- `git diff --check`: passed.
- `openspec validate youtube-readonly-mcp --strict`: passed.

Coverage includes real subprocess stdio discovery and integration, local
HTTP/WebSocket CDP exchanges, identity parsing, refresh/account-change locks,
error classification, secret-safe output/filesystem checks, order/duplicates,
modern continuation and Shorts layouts, cursor replay and TTL/LRU/memory bounds,
cancellation, deadlines, examples, default-limit behavior, and live opt-in guards.
The default suite still does not access Neko or YouTube.

## Observability writer: local verification

Bun 1.4.2 subprocess tests exercise actual stderr pipes independently of
YouTube, Neko, or an account. A worker attempts 30,000 safe diagnostic records
while its parent does not consume stderr. It still reports progress over
stdout, with at most 256 outstanding records and 256 KiB tracked bytes.
After consumption resumes, every emitted line parses as JSON and emitted
start records plus reported losses account for all 30,000 attempts.
Closing the parent's stderr pipe disables logging while the worker continues
and exits successfully. These checks isolate the writer; complete MCP
lifecycle and stage coverage is recorded in the final local checks below.

Writable tests additionally cover the internal stream queue, UTF-8 byte and
record limits, whole-record rejection, level-filtered loss reports, write
throws/callback errors, and the one-second flush timeout. These are local
results, not additional live reads or performance acceptance evidence.

## Observability measurement conditions: local verification

A real stdio MCP client reproduced all three conditions against local CDP and
HTTP upstream fixtures. Five fresh processes each performed one cold read;
one process performed one preparation plus five warm reads; another performed
two preparation calls plus five replays of the same cursor. Logs matched the
expected cache states and replayed MCP results were identical.

| Local condition | Measured attempts | Preparation calls | CDP acquisitions | Library HTTP reads |
| ------------------- | ----------------: | ----------------: | ---------------: | -----------------: |
| Cold authentication | 5 | 0 | 5 | 5 |
| Warm authentication | 5 | 1 | 1 | 6 |
| Same-cursor replay | 5 | 2 | 1 | 1 |

The fixture observed 19 total browse requests: 7 identity reads and 12 library
reads. This checks measurement **conditions**, not real-account latency or an
SLO. No new executable benchmark or live access was needed. Account approval
for the earlier five-item smoke check does not authorize future repeats.

## Observability final local checks

Verified in `nix develop .#youtube` without Neko, YouTube, or a personal account:

- `bun install --frozen-lockfile`: 106 installs across 123 packages checked,
  no dependency changes.
- `bun run format` and `bun run check`: passed (Prettier and TypeScript).
- `bun run test`: **107 passed, 0 failed**, across **29** protocol test files;
  this run made 2,767 assertions.
- `git diff --check`: passed.
- `openspec validate youtube-observability --strict`: passed.
- `openspec validate youtube-readonly-mcp --strict`: passed.

Real subprocess integration at both info and debug covers all five unchanged
tool results, concurrent acquisition, request/stage correlation, timeouts,
cancellation, account-change locks, and generated opaque cursors. Debug logs
exclude returned titles/IDs/cursors as well as credentials. Isolated HOME and
XDG paths are scanned for unexpected files and a runtime-only cookie sentinel;
only Bun compilation-cache files are allowed and none contains the sentinel.

Separate actual-pipe integration fills stderr before MCP startup. With stderr
never consumed, or with its actual pipe closed, discovery and authenticated
fixture reads still succeed; deadlines abort upstream work, client cancellation
propagates, subsequent reads recover, and shutdown exits successfully. Lifecycle
tests cover EOF, repeated signals, safe fatal/configuration failures, and the
one-second flush budget. The live checker accepts bounded allowlisted JSONL
instead of requiring zero stderr bytes; its no-opt-in guard still prevents
network access.

Source review retained the fixed browse-only URL/method and redirect guards,
in-memory cookie/session/cursor policy, tool schemas, public error codes,
30-second production deadline, and pinned dependencies. There is no new benchmark
command, automatic account workload, logger file storage, exporter, or deployment.
This evidence does not measure real-account performance or guarantee lossless
logs, hidden YouTube compatibility, or behavior on runtimes other than pinned Bun.
New real-account checks still require explicit scope approval.

## Stacked review verification

Pre-review verification checked all **37 revisions** individually in an isolated
worktree, using the pinned development-shell Bun. Each revision passed:

- `nix flake check --no-build --all-systems` (all three declared systems);
- `nix flake check` (full evaluation and formatting check on aarch64-darwin);
- `nix fmt -- --fail-on-change`.

The 36 revisions containing the YouTube package also passed
`bun install --frozen-lockfile` and `bun run check`. The 35 revisions with protocol
tests passed `bun test tests/protocol`; the first Nix-only revision and the initial
tooling scaffold have no protocol tests yet.

Python workspace removal is the first revision, so no subsequent revision exports
environments backed by a nonexistent `uv.lock`. The default and named YouTube
shells both provide Bun.

Four intentionally failing test-only revisions were folded into their following
implementations, rather than leaving broken intermediate PRs. Markdown formatting
was normalized at each revision. Prettier now leaves Markdown to the repository's
mdformat so the two formatter checks agree. Runtime code, dependency pins, and
existing `Change-Id` trailers were preserved. The final suite still passes all
107 tests. Linux outputs were evaluated, not built or runtime-tested. These are
local macOS checks, not Linux CI or renewed live-account verification.

## External measurement record template

Follow the [external procedure](README.md#external-latency-verification).
This table is a template, not a new account measurement or a benchmark command.
Record tool name, limit, log level, runtime, collector conditions, approved scope,
attempt/preparation counts, and total budget before filling it in. Defaults are
five attempts per condition and five minutes total including preparation.
Never record private playlist/video/account IDs, titles, or cursors.

| Condition | Attempts | Successes with server timing | Failures / safe codes | Server median / min / max ms | Client round-trip median / min / max ms | Startup median / min / max ms | Missing logs / skipped / stop reason |
| ------------------- | -------: | ---------------------------: | --------------------- | ---------------------------- | --------------------------------------- | ----------------------------- | ------------------------------------ |
| Cold authentication | — | — | — | — | — | — | — |
| Warm authentication | — | — | — | — | — | N/A | — |
| Same-cursor replay | — | — | — | — | — | N/A | — |

Also report client-observed successes without matched server timing separately.
The success count used for each timing statistic must match that statistic's
available samples. A missing or ambiguous record is not a failed query and must
not shift later completions onto the wrong requests. Preparation is excluded
from latency samples but included in total requests and elapsed budget.

**Synthetic arithmetic example, not measured latency:** five attempts produce
successful server durations of 10, 20, and 30 ms, one `UPSTREAM_UNAVAILABLE`,
and one `TIMEOUT`. Report 3 successes, median 20 ms, min 10 ms, max 30 ms,
and 2 failures. Client round-trip and startup are N/A if not independently
measured. With no successes, all success-duration statistics are N/A.

Stop immediately on `AUTH_REQUIRED`, `ACCOUNT_CHANGED`, `UPSTREAM_BLOCKED`, or
`RATE_LIMITED`; stop and cancel the pending request on budget exhaustion.
Other failures are separate from successful latency samples. Preserve partial
results and the reason for stopping; missing cursors or failed preparation
produce explicit skips. No p95, fixed latency pass/fail threshold, SLO, or
automatic architecture/implementation classification is implied. Further real
account measurements require fresh approval covering preparation and repeats.

## Remaining limits

The historical live section verifies five items per tool on one account, not exhaustive
library traversal or compatibility with every account/layout. Account identity
was checked for consistency across tools, not independently compared with a
manually supplied browser channel ID. Future unknown structures fail closed.
Remote edits may affect traversal. CDP and cookies retain broader authority
outside the MCP's read-only boundary. Further live access still requires
operator approval; a passing suite does not imply standing permission.
