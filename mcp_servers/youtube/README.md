# YouTube MCP

Read-only YouTube MCP server using Bun and TypeScript.

Current implementation supports stdio initialization, tool discovery, strict
input validation, safe errors, cancellation, and a 30-second request deadline.
The YouTube backend is not connected yet: valid reads return
`UPSTREAM_UNAVAILABLE`. The CDP and account-session adapters are implemented
and tested separately, but not yet wired into stdio library reads.

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

## Tests

```sh
bun test tests
```

The protocol suite starts a real Bun subprocess and MCP client to check
initialization, discovery, error responses, and shutdown without a browser.
In-process MCP sessions exercise schema rejection, secret-safe errors,
deadlines, and cancellation. These tests do not access a personal account.

## Browser session boundary

Once library reads are wired, authentication is lazy: the first read acquires
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

## Remaining work

Library response normalization, bounded pagination, and full stdio-to-upstream
integration remain pending. HTTP deployment, Nix application packaging, and
all writes are separate changes. Live read-only testing requires explicit
approval and is not part of the default suite.
