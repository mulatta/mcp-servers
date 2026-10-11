"""Bound concurrent lookups with real MCP calls against a real browser."""

import asyncio
from typing import Any

import anyio
import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError
from linkedin_mcp.browser import BrowserBusyError, BrowserSession
from linkedin_mcp.server import create_server
from patchright.async_api import Route, async_playwright

PROFILE = """<!doctype html><html><head><title>Example Member</title></head>
<body><main><h1>Example Member</h1>
<p>Research engineer building reproducible scientific tools.</p>
</main></body></html>"""
ARGUMENTS = {"linkedin_username": "example-member", "max_scrolls": 1}


async def wait_admitted(session: BrowserSession, count: int) -> None:
    with anyio.fail_after(10):
        while session._admitted != count:
            await anyio.sleep(0.01)


@pytest.mark.asyncio
async def test_third_call_is_busy_and_waiting_cancel_frees_slot(
    chromium: tuple[str, str],
) -> None:
    session = BrowserSession(chromium[0])
    running = asyncio.Event()
    release = asyncio.Event()
    async with async_playwright() as observer:
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        context = browser.contexts[0]
        originals = set(context.pages)

        async def serve(route: Route) -> None:
            page = route.request.frame.page
            if route.request.service_worker is not None or page in originals:
                await route.continue_()
                return
            running.set()
            await release.wait()
            await route.fulfill(status=200, content_type="text/html", body=PROFILE)

        await context.route("**linkedin.com/**", serve)
        try:
            async with Client(create_server(session)) as client:
                results: dict[str, Any] = {}

                async def call(name: str) -> None:
                    results[name] = await client.call_tool(
                        "get_person_profile", ARGUMENTS
                    )

                async with anyio.create_task_group() as group:
                    group.start_soon(call, "running")
                    with anyio.fail_after(30):
                        await running.wait()
                    await wait_admitted(session, 1)
                    tabs = len(context.pages)

                    waiting_scope = anyio.CancelScope()

                    async def cancellable() -> None:
                        with waiting_scope:
                            await call("cancelled")

                    group.start_soon(cancellable)
                    await wait_admitted(session, 2)

                    with anyio.fail_after(5):
                        with pytest.raises(ToolError, match="busy"):
                            await client.call_tool("get_person_profile", ARGUMENTS)
                    assert len(context.pages) == tabs
                    assert session._admitted == 2

                    waiting_scope.cancel()
                    await wait_admitted(session, 1)
                    # Cancelling the waiter must not disturb the running lookup.
                    assert "running" not in results

                    group.start_soon(call, "after_cancel")
                    await wait_admitted(session, 2)
                    release.set()

                assert "cancelled" not in results
                for name in ("running", "after_cancel"):
                    assert (
                        "Example Member"
                        in results[name].data["sections"]["main_profile"]
                    )
                assert session._admitted == 0
        finally:
            await session.close()
        assert set(context.pages) == originals
        assert browser.is_connected()


class SlowCleanupSession(BrowserSession):
    def __init__(self, endpoint: str) -> None:
        super().__init__(endpoint)
        self.cleaning = asyncio.Event()
        self.finish_cleanup = asyncio.Event()

    async def _close_tab(self) -> None:
        if self._target_id is not None:
            self.cleaning.set()
            await self.finish_cleanup.wait()
        await super()._close_tab()


@pytest.mark.asyncio
async def test_slot_is_held_until_cleanup_finishes(chromium: tuple[str, str]) -> None:
    session = SlowCleanupSession(chromium[0])
    entered = asyncio.Event()

    async def lease() -> None:
        async with session.lease():
            entered.set()

    try:
        async with anyio.create_task_group() as group:
            group.start_soon(lease)
            with anyio.fail_after(30):
                await session.cleaning.wait()
            group.start_soon(lease)
            await wait_admitted(session, 2)
            with pytest.raises(BrowserBusyError):
                async with session.lease():
                    pass
            session.finish_cleanup.set()
        assert session._admitted == 0
    finally:
        session.finish_cleanup.set()
        await session.close()
