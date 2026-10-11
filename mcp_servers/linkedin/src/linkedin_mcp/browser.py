"""Own a tab and driver connection, never the external browser."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import anyio
from patchright.async_api import Browser, Error, Page, Playwright, async_playwright

logger = logging.getLogger(__name__)


class BrowserConnectionError(RuntimeError):
    """A safe diagnostic that never embeds driver errors or endpoint secrets."""

    def __init__(self) -> None:
        super().__init__(
            "CDP connection failed or was lost. Check discovery WebSocket address "
            "reachability and TCP relay status; retry explicitly after recovery."
        )


class BrowserSession:
    def __init__(self, endpoint: str) -> None:
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https", "ws", "wss"} or not parsed.hostname:
            raise ValueError("CDP endpoint must be an HTTP(S) or WS(S) URL")
        self.endpoint = endpoint
        self.page: Page | None = None
        self._driver: Playwright | None = None
        self._browser: Browser | None = None
        self._lock = asyncio.Lock()

    async def _connect(self) -> Page:
        if self._browser is not None and not self._browser.is_connected():
            await self._close()
        if self.page is not None and self.page.is_closed():
            await self._close()
        if self.page is None:
            try:
                self._driver = await async_playwright().start()
                self._browser = await self._driver.chromium.connect_over_cdp(
                    self.endpoint, timeout=15000
                )
                if not self._browser.contexts:
                    raise RuntimeError("CDP browser has no existing default context")
                self.page = await self._browser.contexts[0].new_page()
            except Error:
                raise BrowserConnectionError() from None
        return self.page

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[Page]:
        async with self._lock:
            try:
                # Remote resource creation must finish before cancellation can
                # discard the handle needed to release the newly created tab.
                with anyio.CancelScope(shield=True):
                    page = await self._connect()
                await anyio.lowlevel.checkpoint()
                yield page
                if self._browser is None or not self._browser.is_connected():
                    raise BrowserConnectionError()
            except Error:
                disconnected = self._browser is None or not self._browser.is_connected()
                await self._close()
                if disconnected:
                    raise BrowserConnectionError() from None
                raise
            except BaseException as error:
                disconnected = (
                    self._browser is not None and not self._browser.is_connected()
                )
                await self._close()
                if disconnected and isinstance(error, Exception):
                    raise BrowserConnectionError() from None
                raise

    async def _close(self) -> None:
        page, driver = self.page, self._driver
        self.page = None
        self._driver = None
        self._browser = None
        # FastMCP cancels with AnyIO scopes; cleanup must outlive that scope.
        with anyio.CancelScope(shield=True):
            try:
                if page is not None and not page.is_closed():
                    with anyio.move_on_after(5) as closing:
                        await page.close()
                    if closing.cancel_called:
                        logger.warning(
                            "CDP tab cleanup timed out; owned tab may remain"
                        )
            except Error:
                logger.warning("CDP tab cleanup unavailable; owned tab may remain")
            finally:
                if driver is not None:
                    with anyio.move_on_after(5) as stopping:
                        await driver.stop()
                    if stopping.cancel_called:
                        logger.warning("CDP driver cleanup timed out")

    async def close(self) -> None:
        async with self._lock:
            await self._close()
