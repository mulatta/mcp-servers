# Developing the YouTube MCP

## Setup

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

## Tests

`bun run test` runs the protocol suite against local fixtures: a real Bun
subprocess and MCP client for discovery and shutdown, in-process sessions for
schema rejection, errors, deadlines and cancellation, HTTP fail-closed paths,
and every write tool's input checks, request bodies, confirmation rules and
`WRITE_OUTCOME_UNKNOWN` paths. No test touches a browser or account. The flake
checks also build the package with tests, the flakelet units, and a NixOS VM
test of the HTTP service.

## Live checks

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
