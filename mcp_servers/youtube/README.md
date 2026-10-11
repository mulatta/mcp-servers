# YouTube MCP

Preparation scaffold for a Bun + TypeScript MCP server backed by YouTube.js.
No MCP transport or tools are implemented yet. Nothing reads credentials or
contacts YouTube.

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
