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

## Input and logging checks

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

## Local checks

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

## Remaining limits

This verifies five items per tool on one authenticated account, not exhaustive
library traversal or compatibility with every account/layout. Account identity
was checked for consistency across tools, not independently compared with a
manually supplied browser channel ID. Future unknown structures fail closed.
Remote edits may affect traversal. CDP and cookies retain broader authority
outside the MCP's read-only boundary. Further live access still requires
operator approval; a passing suite does not imply standing permission.
