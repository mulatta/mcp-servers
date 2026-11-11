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

Without the opt-in it exits before contacting CDP.

### Test browser

Live feature tests run against a separate Google account in a local browser,
so they never change your own account. `bun run live:setup` manages that
browser: a rootless podman container from the same pinned Neko image as
production, with every port bound to `127.0.0.1` and its profile under
`$XDG_DATA_HOME/youtube-mcp/live-neko`. It needs podman with rootless support
and pulls the image (about 1.5 GB) on the first start.

1. Copy `.env.test.example` to `.env.test`. Change any port that collides on
   the host; setup names a port that is already taken over TCP or UDP.
1. Set `YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID` to your own channel ID. Setup and
   every live write refuse that account.
1. Run `bun run live:setup`. It starts the browser, prints how to reach its
   UI, and waits up to ten minutes (`--timeout <minutes>`) for the test
   account, reporting what is missing as it goes.
1. Open the UI, join with the admin password from the generated `neko.env`,
   take control, and sign in to the test account on youtube.com.
1. Create a YouTube channel for the test account (profile menu, then *Create
   a channel*). Without one, the account has no channel ID and every read
   fails with `AUTH_REQUIRED`.

Once the browser holds the test account, setup records it in `.env.test`: it
sets `YOUTUBE_LIVE_ACCOUNT_ID` and removes a `YOUTUBE_LIVE_CDP_URL` that names
another browser, leaving other lines as they are. It then stops the browser,
as it also does on timeout or Ctrl-C; the sign-in stays in the profile.
`--keep` leaves the browser running. A profile that is already signed in
finishes without instructions.

The UI streams video over WebRTC from `127.0.0.1:<media port>`. Browsers
refuse loopback WebRTC candidates by default, so joining succeeds but the
screen never appears until the viewing browser allows them: set
`media.peerconnection.ice.loopback` to `true` in Firefox's `about:config`, or
start Chromium with `--allow-loopback-in-peer-connection`. From another
machine, forward the UI port and the media port (TCP) to the same ports
there.

For manual work, `up` starts the browser, `status` shows whether the
container and DevTools are up, `check` reads the signed-in account and lists
the `.env.test` keys it would change (`check --write` applies them), `down`
stops the container and keeps the profile, and `down --purge` deletes the
profile too.

### Live feature tests

`tests/live/` exercises the features themselves against the test account.
The Nix build runs only `tests/protocol`, so these tests never run there.
`bun run live:test` starts the test browser, confirms it holds
`YOUTUBE_LIVE_ACCOUNT_ID`, runs the suite against it, and stops the browser
again, also on failure or Ctrl-C:

```sh
bun run live:test                      # reads only
bun run live:test --writes             # reads and writes; clears the test account
bun run live:test --writes -- e2e      # one file; arguments after -- go to bun test
```

`--keep` leaves the browser running. Setting `YOUTUBE_LIVE_LOG` to a file
collects the servers' debug logs there, which carry stages and safe codes but
no IDs. The suite can also run directly with `bun run test:live:features` and
`YOUTUBE_LIVE=1` (plus `YOUTUBE_LIVE_WRITES=1`); without `YOUTUBE_LIVE=1`
every live test is skipped, so a plain `bun test` stays offline.

Writes refuse to start without both `YOUTUBE_LIVE_ACCOUNT_ID`, the test
account, and `YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID`, an account they must never
change, or when the two are equal. Every file reads the account first and
stops before any write, including cleanup, if the browser is signed into the
personal account or any account other than the pinned one.

The write suite, `e2e.test.ts`, owns the test account's state and starts from
nothing rather than from prepared data:

1. It clears the account with the removal tools (deletes its playlists,
   empties Watch Later, removes likes, unsubscribes) and checks that every
   list reads empty, again after 20 seconds.
1. It subscribes to two public Google channels, reads them and the
   subscription feed back, and cycles one channel's bell; an unfollowed
   channel is refused.
1. It likes videos, including one twice, and removes a rating twice.
1. It adds 105 public uploads to Watch Later in batches of 50, reads every
   page in order, moves an entry to the top and back, and removes some.
1. It creates a private playlist, changes its title, description and
   privacy, adds, moves and removes videos, checks the not-found and
   ambiguous-move refusals, and deletes it.
1. It plays one video in the test browser and finds it at the top of the
   watch history, which no tool writes or clears.
1. It clears the account again; `afterAll` repeats that after a failure.

Videos come from a public channel's uploads, so the suite needs nothing on
the account to start. Reads (`reads.test.ts`) check what holds on any
account: every list tool's limit and account, a public channel's uploads,
playlist details and an unknown channel. Over HTTP, with a throwaway token on
a free loopback port, the suite checks `initialize` instructions, the tool
list, a read, a refused token, `Connection: close` with the socket closed,
and a playlist write cycle. With writes enabled it also reproduces
`WRITE_OUTCOME_UNKNOWN`: an in-process server whose network wrapper lets a
create and an add reach YouTube, then drops or delays their answers, must
report the outcome as unknown while the playlist and the added video exist.
A full run with writes takes about three minutes. Assertions compare booleans
and counts, so a failure names the step but never prints IDs or titles.
[VERIFICATION.md](VERIFICATION.md) records each run.

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
