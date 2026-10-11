# YouTube MCP

Read-only YouTube MCP server using Bun and TypeScript.

Five read-only tools are connected to the CDP session provider, YouTube.js
adapter, normalization, and bounded pagination. Stdio discovery is credential
free; actual reads authenticate lazily. Local integration tests pass. Personal
account compatibility has not been live-verified.

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

## Tools

| Tool | Purpose | Required input |
| --------------------------- | ----------------- | -------------- |
| `youtube_list_playlists` | Account playlists | None |
| `youtube_get_playlist` | Playlist contents | `playlist_id` |
| `youtube_get_watch_later` | Watch Later | None |
| `youtube_get_liked_videos` | Liked videos | None |
| `youtube_get_watch_history` | Watch history | None |

All tools accept optional `limit` (integer 1–100, default 50) and `cursor`.
Playlist IDs contain letters, digits, `_`, or `-`; URLs are not accepted.
Unknown arguments are rejected before backend access. All five tools declare
read-only, non-destructive annotations. No write or arbitrary API tools exist.

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

[Validated examples](examples/results.json) cover all five tools. Successful
responses contain identical JSON in `structuredContent` and text content:

- `account_id`: verified, pinned channel ID, not a display name or email.
- `items`: ordered summaries, including repeats and explicit placeholders.
- `next_cursor`: opaque in-process cursor or `null`.
- `has_more`: whether `next_cursor` is non-null.

`youtube_list_playlists` returns `playlist_id`, `title`, and `video_count`.
All other tools return `video_id`, `title`, `url`, `channel_name`, and
`availability` (`available`, `private`, `deleted`, `unavailable`, or `null`).
`youtube_get_watch_history` additionally returns `watched_at` and `group_label`.
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
deadlines, and cancellation. These tests do not access a personal account.

## Browser session boundary

Authentication is lazy: the first read acquires
cookies from an existing page in Neko Chromium's default context over CDP.
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

Malt exposes CDP on its own loopback `127.0.0.1:9222`. That is not the developer
machine's loopback. Remote execution requires an operator-managed SSH tunnel
or running alongside Neko. This package does not create tunnels, expose ports,
change firewall rules, or deploy Neko. Never expose CDP publicly. Neko UI login
through Kanidm is separate from the YouTube login and CDP access controls.

On `AUTH_REQUIRED`, open Neko manually and sign into the intended default
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

Do not run this without the account owner's explicit approval. It reads one
item per tool, prints only counts/account-match status, and never modifies
account data. Set the expected channel ID and an existing playlist ID after
checking them manually in Neko. IDs are not cookie or authentication values.

```sh
YOUTUBE_LIVE_READONLY=1 \
YOUTUBE_LIVE_ACCOUNT_ID=UC_REPLACE_WITH_CHANNEL_ID \
YOUTUBE_LIVE_PLAYLIST_ID=PL_REPLACE_WITH_PLAYLIST_ID \
YOUTUBE_CDP_URL=http://127.0.0.1:9222 \
bun run test:live
```

Without opt-in the command exits before loading the reader or contacting CDP.
It is not a `*.test.ts` file and is excluded from the default test command.
The default suite uses local protocol fixtures, not Neko or YouTube.
See [VERIFICATION.md](VERIFICATION.md) for recorded verification limits.

## Verification boundary

Local integration covers stdio through HTTP/WebSocket CDP and upstream
fixtures, including cancellation, timeout, account changes, and secret-safe
failures. This is not proof that a personal account's current YouTube response
matches those fixtures. Unsupported structures fail closed.

HTTP deployment, Nix application packaging, and all writes are separate
changes. Live read-only testing requires explicit approval and is not part
of the default suite.
