# LinkedIn CDP MCP

Work in progress. The workspace, initial CDP connection, and CLI exist, but no profile tools are registered yet. Do not use this as a production server.

## Development checks

```sh
uv sync --all-packages --python 3.13
uv run ruff check mcp_servers/linkedin
uv run mypy mcp_servers/linkedin/src mcp_servers/linkedin/tests
TEST_CHROMIUM=/path/to/Chromium uv run pytest mcp_servers/linkedin/tests
```

Non-destructive tests against an existing shared browser require explicit opt-in. Obtain the WebSocket address from `/json/version`.

```sh
TEST_CDP_URL=http://127.0.0.1:9222 \
TEST_CDP_WS_URL=ws://127.0.0.1:9222/devtools/browser/ACTUAL-ID \
uv run pytest mcp_servers/linkedin/tests
```

Tests never navigate existing tabs and read HTML only in disposable tabs they create. Requests are serialized, and tab and driver cleanup is protected from AnyIO cancellation. Tests cover normal shutdown, request cancellation, and recovery after a failed CDP handshake. Opting in does not authorize terminating the shared browser or forcing logout.

`TEST_CHROMIUM` must point to a working local Chromium executable. Tests launch it with a temporary profile and a separate CDP port, never the user's existing profile. The production MCP does not launch a browser.

Disconnect tests close only sockets belonging to a test-specific TCP relay, not Neko or an existing SSH tunnel. In-flight requests fail, and the next explicit request reconnects without replaying the failed request. The application does not guess ownership to remove tabs left behind after disconnection. Only the tests use a separate observer to clean up exact tab handles they created.

Nine tests cover required options, HTTP/WS connections, serialization, cancellation cleanup, initialization failures, idle and in-flight disconnects, and secret-free errors. They passed against Neko Chrome 154 through development-only SSH local forwarding. LinkedIn profile retrieval, login recovery, and production Nix packaging remain unverified.

Enter the editable Nix development environment with `nix develop .#default`. The development shell overlay supplies `editables` for Hatchling's editable build.

The production endpoint is `http://127.0.0.1:9222` on the malt host. Kanidm protects access to the Neko UI; local processes that can reach CDP have full control of the browser.
