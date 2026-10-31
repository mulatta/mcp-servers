import anyio
import pytest
from linkedin_mcp.browser import BrowserSession
from patchright.async_api import Page, async_playwright


async def target_id(page: Page) -> str:
    cdp = await page.context.new_cdp_session(page)
    try:
        info = (await cdp.send("Target.getTargetInfo"))["targetInfo"]
        return str(info["targetId"])
    finally:
        await cdp.detach()


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "failure", "cancel"])
async def test_request_tabs_close_without_reconnecting(
    chromium: tuple[str, str], outcome: str
) -> None:
    session = BrowserSession(chromium[0])
    async with async_playwright() as observer:
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        originals = list(browser.contexts[0].pages)
        try:
            async with session.lease() as first:
                first_id = await target_id(first)
                connection = session._browser
                driver = session._driver
            assert first.is_closed()
            assert session.page is None
            assert connection is not None and connection.is_connected()
            second: Page | None = None

            async def request() -> None:
                nonlocal second
                async with session.lease() as second:
                    assert await target_id(second) != first_id
                    assert session._browser is connection
                    assert session._driver is driver
                    if outcome == "failure":
                        raise ValueError("Synthetic extraction failure")
                    if outcome == "cancel":
                        scope.cancel()
                        await anyio.sleep_forever()

            if outcome == "failure":
                with pytest.raises(ValueError, match="Synthetic extraction failure"):
                    await request()
            else:
                with anyio.CancelScope() as scope:
                    await request()
            assert second is not None and second.is_closed()
            assert session.page is None
            assert session._browser is connection
            assert session._driver is driver
            assert connection.is_connected()
        finally:
            await session.close()
        assert browser.is_connected()
        assert all(not page.is_closed() for page in originals)
