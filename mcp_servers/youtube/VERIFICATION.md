# Verification record

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
