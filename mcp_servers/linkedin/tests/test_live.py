"""Explicitly opt-in live lookup; never change login state or existing tabs."""

import asyncio
import os
import sys
from pathlib import Path

import pytest
from fastmcp import Client
from fastmcp.client.transports import StdioTransport
from linkedin_mcp_server.linkedin.identifiers import normalize_person_identifier
from patchright.async_api import async_playwright


@pytest.mark.asyncio
async def test_live_profile_and_stdio_shutdown() -> None:
    profile = os.environ.get("LINKEDIN_TEST_PROFILE")
    if not profile:
        pytest.skip("Set LINKEDIN_TEST_PROFILE to an explicitly authorized profile")
    endpoint = os.environ.get("TEST_CDP_URL")
    if not endpoint:
        pytest.fail(
            "Live checks require TEST_CDP_URL for the existing logged-in browser"
        )
    executable = os.environ.get("LINKEDIN_MCP_EXECUTABLE")
    command = executable or sys.executable
    args = [] if executable else ["-m", "linkedin_mcp"]
    transport = StdioTransport(
        command=command,
        args=[*args, "--cdp-url", endpoint],
        cwd=str(Path(__file__).resolve().parents[1]),
        # Stdio transports filter inherited variables; Nix editables use this
        # one to locate sources. Do not forward the entire environment.
        env={"REPO_ROOT": os.environ["REPO_ROOT"]}
        if "REPO_ROOT" in os.environ
        else None,
        keep_alive=False,
    )
    async with async_playwright() as observer:
        browser = await observer.chromium.connect_over_cdp(endpoint, timeout=15000)
        context = browser.contexts[0]
        originals = list(context.pages)
        addresses = [page.url for page in originals]
        async with Client(transport) as client:
            assert [tool.name for tool in await client.list_tools()] == [
                "get_person_profile"
            ]
            async with context.expect_page() as created:
                result = await client.call_tool(
                    "get_person_profile",
                    {
                        "linkedin_username": profile,
                        "max_scrolls": 1,
                    },
                )
            owned = await created.value
            assert (
                result.data["url"]
                == f"https://www.linkedin.com/in/{normalize_person_identifier(profile)}/"
            )
            assert result.data["sections"].get("main_profile", "").strip()
            assert not result.data.get("section_errors")
            # Cleanup belongs to the request, not transport shutdown.
            async with asyncio.timeout(10):
                while not owned.is_closed():
                    await asyncio.sleep(0.05)
        assert browser.is_connected()
        assert all(not page.is_closed() for page in originals)
        assert all(
            page.url == address
            for page, address in zip(originals, addresses, strict=True)
        )
