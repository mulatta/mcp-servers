# LinkedIn CDP MCP

A stdio MCP server that reads LinkedIn profiles through a Chromium session managed by Neko. It exposes only `get_person_profile`, not the complete upstream server. Extraction uses `mcp-server-linkedin==4.27.0` (Apache-2.0), with `patchright==1.63.0` as the CDP driver.

## Usage

Sign in to LinkedIn through Neko first. The MCP does not install or launch a browser or create cookie files.

```sh
uv sync --all-packages --python 3.13
uv run --package linkedin-mcp linkedin-mcp --cdp-url http://127.0.0.1:9222
```

`--cdp-url` is required and accepts an HTTP(S) discovery URL or a WS(S) browser endpoint. Connection is deferred until the first valid lookup. Enter the Nix development environment with `nix develop .#default` and use the same `linkedin-mcp` command. The development shell overlay supplies `editables` for editable builds.

In production, the MCP runs on the malt host and connects through `127.0.0.1:9222 → container socat :9223 → Chromium :9222`. A separate container's localhost is not the malt host's localhost. Kanidm protects only the Neko UI. Local processes that can reach the CDP port are trusted with full browser control.

## Tool contract

`get_person_profile` preserves the upstream input constraints and successful result structure.

| Argument | Type | Default |
| --- | --- | --- |
| `linkedin_username` | LinkedIn username or profile URL string | Required |
| `sections` | Comma-separated extra section names, or null | null |
| `max_scrolls` | Integer from 1 to 50, or null | null |

The main profile is always read. Extra sections are experience, education, interests, honors, languages, certifications, skills, projects, contact_info, and posts. Null pagination uses upstream defaults: 5 detail clicks or 10 post scrolls. Unknown section names are returned in `unknown_sections`.

Results contain `url` and raw text in `sections`, with optional `references`, `profile_urn`, `section_errors`, and `unknown_sections`. Empty extraction results are not reported as successes. Invalid input is rejected before browser connection or navigation.

Upstream saved-account selection and subsequent navigation back to the profile are allowed. Password entry, new login flows, and checkpoint resolution are not automated. When interactive authentication is required, complete it in Neko and call the tool again. Extraction failures are distinguished from authentication requirements.

## Browser lifetime

The MCP creates a dedicated tab in the existing context and serializes lookups. Shutdown and request cancellation release only that tab and the client connection, preserving user tabs, the browser, and its login session. Connection loss fails the in-flight request; the next explicit request reconnects. Failed requests are never replayed automatically.

The application does not guess ownership to remove tabs left behind after disconnection. Connection errors omit endpoint passwords and tokens and suggest checking discovery addresses and relay availability.

## Development checks

```sh
uv run ruff check mcp_servers/linkedin
uv run mypy mcp_servers/linkedin/src mcp_servers/linkedin/tests
TEST_CHROMIUM=/path/to/Chromium uv run pytest mcp_servers/linkedin/tests
```

`TEST_CHROMIUM` must point to a working local Chromium executable. Tests use a temporary profile and a separate CDP port. Testing against an existing shared browser requires explicit opt-in. Obtain the WebSocket address from `/json/version`.

```sh
TEST_CDP_URL=http://127.0.0.1:9222 \
TEST_CDP_WS_URL=ws://127.0.0.1:9222/devtools/browser/ACTUAL-ID \
uv run pytest mcp_servers/linkedin/tests
```

Tests never navigate existing tabs. Profile and authentication tests fulfill requests in their own dedicated tabs with fixed HTML and read it using the actual upstream extractor. These fixtures do not verify successful responses from LinkedIn itself. Tests also verify that authentication forms are not filled or submitted and that only saved-account selection is automated.

Disconnect tests close only sockets belonging to a test-specific TCP relay, not Neko or an existing SSH tunnel. A separate observer cleans up only exact tab handles created by the tests. The shared browser is never terminated or forcibly logged out.

Twenty-three automatic tests cover CDP lifetime, MCP initialization, tool listing, input constraints, and profile extraction, authentication, and empty-result handling with fixed DOM fixtures. They passed against Neko Chrome 154 through development-only SSH local forwarding. A user-authorized live profile lookup also succeeded over stdio: after an authwall error, the user signed in through Neko and retried successfully. Explicit transport shutdown closed the exact dedicated tab while preserving existing tabs. The verification client uses `StdioTransport(keep_alive=False)`; the default True keeps the server alive after the client connection scope exits, so tab closure must not be expected then. Direct execution on malt and production Nix packaging still require separate opt-in verification.

## Opt-in verification on malt

Run these commands on the malt host, not inside a separate container. Keep the existing Neko relay and firewall configuration unchanged. Sign in through the Neko UI first; Kanidm UI authentication does not authenticate CDP.

The automatic connection tests accept the HTTP discovery URL and the explicit WebSocket address returned by its `/json/version` endpoint. Confirm that this address is reachable from the MCP process. The relay forwards TCP unchanged; neither the application nor this procedure rewrites discovery responses. A separate local test server verifies that successful discovery followed by a rejected WebSocket produces a connection error with relay guidance.

For one real profile lookup and stdio shutdown verification, supply only a profile you are authorized to read:

```sh
TEST_CDP_URL=http://127.0.0.1:9222 \
LINKEDIN_TEST_PROFILE=https://www.linkedin.com/in/YOUR-AUTHORIZED-PROFILE/ \
uv run pytest mcp_servers/linkedin/tests/test_live.py -q
```

This live test is skipped unless `LINKEDIN_TEST_PROFILE` is set. It checks the main profile, preserves existing tabs, explicitly shuts down the stdio transport, and verifies that the exact newly created tab closes. It does not force logout, solve checkpoints, or print profile content on success. To test a packaged server, set `LINKEDIN_MCP_EXECUTABLE` to its absolute executable path.

If LinkedIn asks for authentication, complete it manually in Neko and rerun the command. Record a saved-account chooser separately if one appears naturally; do not sign out or alter cookies to force that state. Development-only SSH forwarding is not evidence that the MCP has run directly on malt.
