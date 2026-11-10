import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError
from linkedin_mcp.browser import BrowserSession
from linkedin_mcp.server import create_server
from patchright.async_api import Route

PROFILE = "<title>Example Member</title><main><h1>Example Member</h1><p>Research engineer working on reproducible scientific software.</p></main>"


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["login", "checkpoint", "empty"])
async def test_auth_and_extraction_errors(
    chromium: tuple[str, str], state: str
) -> None:
    session = BrowserSession(chromium[0])
    submitted: list[str] = []
    try:
        async with session.acquire() as page:

            async def serve(route: Route) -> None:
                url = route.request.url
                if "/submitted" in url:
                    submitted.append(url)
                if state == "checkpoint" and "/in/" in url:
                    await route.fulfill(
                        status=302,
                        headers={
                            "Location": "https://www.linkedin.com/checkpoint/challenge"
                        },
                    )
                    return
                if state == "empty":
                    html = "<title>Example Member</title><main></main>"
                else:
                    title = "LinkedIn Login" if state == "login" else "Security Check"
                    html = f"""<title>{title}</title><main><form action='/submitted'>
                        <input name='password' type='password' oninput="fetch('/submitted')">
                        <button type='submit'>Continue</button></form></main>"""
                await route.fulfill(status=200, content_type="text/html", body=html)

            await page.route("**/*", serve)
        async with Client(create_server(session)) as client:
            message = "extraction failed" if state == "empty" else "Neko"
            with pytest.raises(ToolError, match=message):
                await client.call_tool(
                    "get_person_profile",
                    {"linkedin_username": "example-member", "max_scrolls": 1},
                )
        assert not submitted
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_saved_account_selection_can_resume(chromium: tuple[str, str]) -> None:
    session = BrowserSession(chromium[0])
    selected = False
    visits = 0
    try:
        async with session.acquire() as page:

            async def serve(route: Route) -> None:
                nonlocal selected, visits
                if "/selected" in route.request.url:
                    selected = True
                    await route.fulfill(status=200, body="ok")
                    return
                visits += 1
                html = (
                    PROFILE
                    if selected
                    else """
                    <title>Example Member</title><main>
                    <div id="rememberme-div"><button onclick="fetch('/selected')">Saved account</button></div>
                    </main>
                """
                )
                await route.fulfill(status=200, content_type="text/html", body=html)

            await page.route("**/*", serve)
        async with Client(create_server(session)) as client:
            result = await client.call_tool(
                "get_person_profile",
                {"linkedin_username": "example-member", "max_scrolls": 1},
            )
            assert selected
            assert visits >= 2
            assert "Example Member" in result.data["sections"]["main_profile"]
    finally:
        await session.close()
