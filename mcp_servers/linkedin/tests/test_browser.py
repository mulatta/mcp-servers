import subprocess
import sys

import pytest
from linkedin_mcp.browser import BrowserSession
from patchright.async_api import async_playwright


def test_endpoint_required() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "linkedin_mcp"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "--cdp-url" in result.stderr
    assert not result.stdout


@pytest.mark.asyncio
@pytest.mark.parametrize("index", [0, 1], ids=["http", "websocket"])
async def test_connect_existing_context(chromium: tuple[str, str], index: int) -> None:
    session = BrowserSession(chromium[index])
    assert session.page is None
    async with async_playwright() as observer:
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        originals = list(browser.contexts[0].pages)
        addresses = [page.url for page in originals]
        try:
            async with session.lease() as page:
                assert page.url == "about:blank"
                await page.set_content("<title>Disposable MCP test</title>")
                assert await page.title() == "Disposable MCP test"
        finally:
            await session.close()
        assert page.is_closed()
        assert browser.is_connected()
        assert all(not original.is_closed() for original in originals)
        assert [original.url for original in originals] == addresses
