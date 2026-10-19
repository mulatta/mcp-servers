"""MCP server lifetime for a lazily connected external browser."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastmcp import FastMCP

from linkedin_mcp.browser import BrowserSession


def create_server(endpoint: str) -> FastMCP:
    session = BrowserSession(endpoint)

    @asynccontextmanager
    async def lifespan(server: FastMCP) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await session.close()

    return FastMCP("linkedin-cdp", lifespan=lifespan)
