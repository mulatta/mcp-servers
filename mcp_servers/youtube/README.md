# YouTube MCP

Read-only YouTube MCP server using Bun and TypeScript.

Current implementation supports stdio initialization, tool discovery, strict
input validation, safe errors, cancellation, and a 30-second request deadline.
The YouTube backend is not connected yet: valid reads return
`UPSTREAM_UNAVAILABLE`. Nothing reads credentials or contacts YouTube yet.

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

## Planned scope

Start with account playlists, Watch Later, liked videos, and watch history.
Keep YouTube.js behind an adapter, normalize responses, and preserve pagination.
Add stdio first; HTTP deployment and Nix application packaging are later work.

Read-only tools are the default. Mutating tools require explicit enablement and
an approval policy before use. MCP annotations alone do not enforce approval.
Do not expose raw Innertube calls, cookie setters, or browser/CDP control tools.

Credentials will come from a runtime file, never tool arguments, source files,
logs, or the Nix store. Follow XDG paths for local configuration and state.
Do not authenticate, export browser cookies, or run live write tests during setup.

## Next implementation step

Write a failing stdio protocol smoke test before implementing server startup.
Then add read-only tools with sanitized fixtures and separately opt-in,
read-only account integration tests. No placeholder passing tests are included.
