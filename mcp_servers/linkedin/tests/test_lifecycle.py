import asyncio

import anyio
import pytest
from linkedin_mcp.browser import BrowserConnectionError, BrowserSession
from patchright.async_api import Page, async_playwright


@pytest.mark.asyncio
async def test_requests_are_serialized(chromium: tuple[str, str]) -> None:
    session = BrowserSession(chromium[0])
    async with async_playwright() as observer:
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        originals = list(browser.contexts[0].pages)
        addresses = [page.url for page in originals]

        async def read(label: str) -> str:
            async with session.lease() as page:
                await page.set_content(f"<main>{label}</main>")
                await asyncio.sleep(0.05)
                return await page.locator("main").inner_text()

        try:
            first, second = await asyncio.gather(read("first"), read("second"))
            assert first == "first"
            assert second == "second"
        finally:
            await session.close()
        assert all(not page.is_closed() for page in originals)
        assert [page.url for page in originals] == addresses


@pytest.mark.asyncio
async def test_failed_initialization_releases_driver(chromium: tuple[str, str]) -> None:
    session = BrowserSession(chromium[1].split("/devtools/")[0] + "/missing-target")
    try:
        with pytest.raises(BrowserConnectionError):
            async with session.lease():
                pytest.fail("Missing CDP browser target unexpectedly connected")
        assert session.page is None
        assert session._driver is None
        session.endpoint = chromium[0]
        async with session.lease() as page:
            assert page.url == "about:blank"
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_cancelled_request_closes_owned_tab(chromium: tuple[str, str]) -> None:
    session = BrowserSession(chromium[0])
    owned: Page | None = None
    try:
        with anyio.CancelScope() as scope:
            async with session.lease() as page:
                owned = page
                scope.cancel()
                await anyio.sleep_forever()
        assert owned is not None
        assert owned.is_closed()
        assert session.page is None
        # A cancellation must not poison the next request's lock or driver.
        async with session.lease() as next_page:
            assert next_page is not owned
            await next_page.set_content("<main>Recovered</main>")
            assert await next_page.locator("main").inner_text() == "Recovered"
    finally:
        # The reference is test-owned even if cancellation loses the session handle.
        if owned is not None and not owned.is_closed():
            await owned.close()
        await session.close()
