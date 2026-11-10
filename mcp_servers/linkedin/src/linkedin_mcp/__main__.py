"""Explicit endpoint configuration for the stdio server."""

import argparse


def main() -> None:
    parser = argparse.ArgumentParser(description="Use an existing Neko CDP browser")
    parser.add_argument(
        "--cdp-url", required=True, help="HTTP(S) or WS(S) CDP endpoint (no default)"
    )
    args = parser.parse_args()
    from linkedin_mcp.browser import BrowserSession
    from linkedin_mcp.server import create_server

    create_server(BrowserSession(args.cdp_url)).run(transport="stdio")


if __name__ == "__main__":
    main()
