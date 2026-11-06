from typing import Any

import pytest
from fastmcp import Client, FastMCP
from fastmcp.exceptions import ToolError
from linkedin_mcp.browser import BrowserSession
from linkedin_mcp.server import create_server
from linkedin_mcp_server.tools.person import register_person_tools
from patchright.async_api import Route


def validation_schema(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: validation_schema(v)
            for k, v in value.items()
            if k not in {"description", "title"}
        }
    if isinstance(value, list):
        return [validation_schema(v) for v in value]
    return value


@pytest.mark.asyncio
async def test_profile_tool_contract() -> None:
    upstream = FastMCP("upstream-contract")
    register_person_tools(upstream)
    expected = await upstream.get_tool("get_person_profile")
    assert expected is not None
    session = BrowserSession("http://127.0.0.1:1")
    async with Client(create_server(session)) as client:
        tools = await client.list_tools()
        assert [tool.name for tool in tools] == ["get_person_profile"]
        assert validation_schema(tools[0].input_schema) == validation_schema(
            expected.parameters
        )
        assert tools[0].annotations is not None
        assert tools[0].annotations.read_only_hint is True
        assert session.page is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"linkedin_username": "someone", "max_scrolls": 0},
        {"linkedin_username": "someone", "max_scrolls": 51},
        {"linkedin_username": "someone", "unexpected": True},
        {"linkedin_username": "https://example.com/in/someone"},
    ],
)
async def test_invalid_input_does_not_connect(arguments: dict[str, Any]) -> None:
    session = BrowserSession("http://127.0.0.1:1")
    async with Client(create_server(session)) as client:
        with pytest.raises(ToolError):
            await client.call_tool("get_person_profile", arguments)
        assert session.page is None
        assert session._driver is None


@pytest.mark.asyncio
async def test_profile_result_from_real_dom(chromium: tuple[str, str]) -> None:
    session = BrowserSession(chromium[0])
    try:
        async with session.acquire() as page:

            async def serve(route: Route) -> None:
                await route.fulfill(
                    status=200,
                    content_type="text/html",
                    body="""
                    <!doctype html><html><head><title>Example Member</title></head>
                    <body><main><h1>Example Member</h1>
                    <p>Research engineer building reproducible scientific tools.</p>
                    <p>Experience in computational biology and data analysis.</p>
                    </main></body></html>
                """,
                )

            await page.route("**/*", serve)
        async with Client(create_server(session)) as client:
            result = await client.call_tool(
                "get_person_profile",
                {
                    "linkedin_username": "example-member",
                    "sections": "not-a-section",
                    "max_scrolls": 1,
                },
            )
            assert result.data["url"] == "https://www.linkedin.com/in/example-member/"
            assert "Example Member" in result.data["sections"]["main_profile"]
            assert result.data["unknown_sections"] == ["not-a-section"]
    finally:
        await session.close()
