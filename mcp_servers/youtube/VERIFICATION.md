# Verification record

## Live status

**Not executed: no approval for personal-account access.** No Neko session,
private cookie, or personal YouTube data was accessed during implementation.
The default suite uses local HTTP/WebSocket fixtures and real MCP clients.
The opt-in command is separate and exits before browser access when disabled.

Residual risks before acceptance on a real account:

- Cookie authentication and the fixed account-settings read may differ on the
  current Chromium/YouTube account. Local tests do not establish live validity.
- Match the returned account identity to the intended default browser channel.
  Missing or ambiguous IDs must remain a safe failure, not an anonymous read.
- Current YouTube layouts may use renderers absent from the sanitized fixtures.
  Unsupported layouts fail closed instead of returning fabricated empty lists.
- WL, LL, history, and private playlist visibility require a real-account
  comparison. Source-derived fixture variations are not a live verification.
- Remote list changes can affect traversal despite lossless local buffering.
- CDP and cookies retain broad account authority outside this MCP boundary.

No account IDs, titles, history entries, cookie values, or original response
bodies belong in this record. Live approval is not implied by a passing suite.

## Local checks

Verified in `nix develop .#youtube`:

- `bun install --frozen-lockfile`: passed without dependency changes.
- `bun run format` and `bun run check`: passed (TypeScript and Prettier).
- `bun run test`: **55 passed, 0 failed**, across 14 protocol test files.
- `git diff --check`: passed.
- `openspec validate youtube-readonly-mcp --strict`: passed.

Coverage includes real subprocess stdio discovery and five-tool integration,
local HTTP/WebSocket CDP exchanges, stable identity parsing, snapshot refresh,
account-change locking, error classification, secret-safe output/filesystem
checks, duplicate-preserving traversal, replay, TTL/LRU/memory bounds,
cancellation, deadlines, documented examples, and disabled-live access guards.

A final regression test confirmed that an evicted cursor cannot hide a
permanent account-change lock. That failure was reproduced before correction.
All these results are local-fixture evidence; live status above is unchanged.
