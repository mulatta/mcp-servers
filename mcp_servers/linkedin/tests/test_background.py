"""Exercise ownership through a real browser and a fault-injecting CDP relay."""

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import anyio
import pytest
from linkedin_mcp.browser import BrowserConnectionError, BrowserSession
from patchright.async_api import Browser, Error, async_playwright
from websockets.asyncio.client import connect
from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

pytestmark = pytest.mark.skipif(
    bool(os.environ.get("TEST_CDP_URL")),
    reason="Protocol initialization faults require a test-owned browser",
)


class CreationRelay:
    """Delay protocol messages without replacing browser or Page implementations."""

    def __init__(self, upstream: str, mode: str) -> None:
        self.upstream = upstream
        self.mode = mode
        self.created = asyncio.Event()
        self.initializing = asyncio.Event()
        self.release = asyncio.Event()
        self.target_id: str | None = None
        self.background = False
        self.activation_commands: list[str] = []
        self.commands: dict[int, str] = {}
        self.creating = False
        self.new_sessions: set[str] = set()

    async def handle(self, client: ServerConnection) -> None:
        delayed: set[asyncio.Task[None]] = set()
        async with connect(self.upstream, max_size=None) as upstream:

            async def later(target: Any, raw: str | bytes) -> None:
                await self.release.wait()
                await target.send(raw)

            def hold(target: Any, raw: str | bytes) -> None:
                task = asyncio.create_task(later(target, raw))
                delayed.add(task)

            async def requests() -> None:
                async for raw in client:
                    message = json.loads(raw)
                    method = message["method"]
                    self.commands[message["id"]] = method
                    if method in {"Target.activateTarget", "Page.bringToFront"}:
                        self.activation_commands.append(method)
                    if method == "Target.createTarget":
                        self.creating = True
                        self.background = message.get("params", {}).get(
                            "background", False
                        )
                    if (
                        method == "Page.getFrameTree"
                        and message.get("sessionId") in self.new_sessions
                    ):
                        self.initializing.set()
                        if self.mode == "cancel":
                            hold(upstream, raw)
                            continue
                        if self.mode == "failure":
                            # Chromium itself returns the unsupported-method error.
                            message["method"] = "Page.syntheticUnsupportedMethod"
                            raw = json.dumps(message)
                    await upstream.send(raw)

            async def responses() -> None:
                async for raw in upstream:
                    message = json.loads(raw)
                    if message.get("method") == "Target.attachedToTarget":
                        params = message["params"]
                        if self.creating:
                            self.new_sessions.add(params["sessionId"])
                    if self.commands.get(message.get("id")) == "Target.createTarget":
                        self.target_id = message["result"]["targetId"]
                        self.created.set()
                        if self.mode == "race":
                            hold(client, raw)
                            continue
                    await client.send(raw)

            workers = [
                asyncio.create_task(requests()),
                asyncio.create_task(responses()),
            ]
            try:
                done, _ = await asyncio.wait(
                    workers, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    try:
                        task.result()
                    except ConnectionClosed:
                        pass
            finally:
                for task in [*workers, *delayed]:
                    task.cancel()
                await asyncio.gather(*workers, *delayed, return_exceptions=True)


@asynccontextmanager
async def creation_relay(
    websocket: str, mode: str
) -> AsyncIterator[tuple[CreationRelay, str]]:
    relay = CreationRelay(websocket, mode)
    async with serve(relay.handle, "127.0.0.1", 0, max_size=None) as server:
        port = server.sockets[0].getsockname()[1]
        try:
            yield relay, f"ws://127.0.0.1:{port}"
        finally:
            relay.release.set()


async def targets(browser: Browser) -> set[str]:
    control = await browser.new_browser_cdp_session()
    try:
        response = await control.send("Target.getTargets")
        return {
            target["targetId"]
            for target in response["targetInfos"]
            if target["type"] == "page"
        }
    finally:
        await control.detach()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["race", "failure", "cancel"])
async def test_background_target_ownership(
    chromium: tuple[str, str], mode: str
) -> None:
    async with (
        async_playwright() as observer,
        creation_relay(chromium[1], mode) as (relay, endpoint),
    ):
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        context = browser.contexts[0]
        originals = await targets(browser)
        session = BrowserSession(endpoint)
        entered = asyncio.Event()
        finish = asyncio.Event()
        scope_ready: asyncio.Future[anyio.CancelScope] = (
            asyncio.get_running_loop().create_future()
        )

        async def request() -> None:
            with anyio.CancelScope() as scope:
                scope_ready.set_result(scope)
                async with session.lease() as page:
                    assert session._browser is not None
                    assert page.context is session._browser.contexts[0]
                    cdp = await page.context.new_cdp_session(page)
                    try:
                        info = (await cdp.send("Target.getTargetInfo"))["targetInfo"]
                        assert info["targetId"] == relay.target_id
                    finally:
                        await cdp.detach()
                    await page.set_content(
                        "<main>Synthetic request initialization</main>"
                    )
                    entered.set()
                    await finish.wait()

        task = asyncio.create_task(request())
        user_page = None
        try:
            await asyncio.wait_for(relay.created.wait(), 10)
            if mode == "race":
                # A user tab appears after our target, before its creation reply.
                user_page = await context.new_page()
                await user_page.set_content(
                    "<title>Synthetic concurrent user tab</title>"
                )
                relay.release.set()
                await asyncio.wait_for(entered.wait(), 20)
                finish.set()
                await asyncio.wait_for(task, 10)
            elif mode == "cancel":
                await asyncio.wait_for(relay.initializing.wait(), 10)
                scope = await scope_ready
                scope.cancel()
                await asyncio.wait_for(task, 10)
                assert not entered.is_set()
            else:
                with pytest.raises((BrowserConnectionError, Error, TimeoutError)):
                    await asyncio.wait_for(task, 25)
                assert relay.initializing.is_set()
                assert not entered.is_set()
            await session.close()
            remaining = await targets(browser)
            assert relay.target_id not in remaining
            assert originals <= remaining
            assert browser.is_connected()
            if user_page is not None:
                assert not user_page.is_closed()
                assert await user_page.title() == "Synthetic concurrent user tab"
            assert relay.background, (
                "Target.createTarget must explicitly request background"
            )
            assert not relay.activation_commands
        finally:
            finish.set()
            relay.release.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await session.close()
            # Failure of the implementation must not leave test-owned targets behind.
            if relay.target_id is not None and relay.target_id in await targets(
                browser
            ):
                control = await browser.new_browser_cdp_session()
                try:
                    await control.send(
                        "Target.closeTarget", {"targetId": relay.target_id}
                    )
                finally:
                    await control.detach()
            if user_page is not None:
                await user_page.close()
