"""MCP server lifetime for a lazily connected external browser."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from linkedin_mcp_server.callbacks import MCPContextProgressCallback
from linkedin_mcp_server.core.auth import detect_auth_barrier
from linkedin_mcp_server.core.exceptions import (
    AccountRestrictedError,
    AuthenticationError,
    InvalidReferenceError,
    LinkedInOperationError,
    RateLimitError,
)
from linkedin_mcp_server.linkedin import LinkedInExtractor, parse_person_sections
from linkedin_mcp_server.linkedin.identifiers import normalize_person_identifier
from patchright.async_api import Error
from pydantic import Field

from linkedin_mcp.browser import (
    BrowserBusyError,
    BrowserConnectionError,
    BrowserSession,
)


def create_server(session: BrowserSession) -> FastMCP:

    @asynccontextmanager
    async def lifespan(server: FastMCP) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await session.close()

    server = FastMCP("linkedin-cdp", lifespan=lifespan)

    @server.tool(
        title="Get Person Profile",
        annotations={"readOnlyHint": True, "openWorldHint": True},
        timeout=180,
    )
    async def get_person_profile(
        linkedin_username: str,
        ctx: Context,
        sections: str | None = None,
        max_scrolls: Annotated[int, Field(ge=1, le=50)] | None = None,
    ) -> dict[str, Any]:
        """Read a LinkedIn profile using the existing Neko session.

        Args:
            linkedin_username: LinkedIn username or full LinkedIn profile URL.
            sections: Comma-separated extra sections. The main profile is always
                read. Supports experience, education, interests, honors,
                languages, certifications, skills, projects, contact_info, posts.
            max_scrolls: Pagination attempts per section, from 1 through 50.
                None uses upstream defaults (5 detail clicks, 10 post scrolls).

        Returns:
            Profile URL and sections of raw text, with optional references,
            profile_urn, section_errors and unknown_sections.
        """
        try:
            username = normalize_person_identifier(linkedin_username)
        except InvalidReferenceError:
            raise ToolError(
                "Provide a LinkedIn username or LinkedIn profile URL."
            ) from None
        requested, unknown = parse_person_sections(sections)
        try:
            async with session.lease() as page:
                result = await LinkedInExtractor(page).read_person(
                    username,
                    requested,
                    callbacks=MCPContextProgressCallback(ctx),
                    max_scrolls=max_scrolls,
                )
                # Navigation can reach an auth screen after the extractor's check.
                if await detect_auth_barrier(page):
                    raise AuthenticationError()
                if not result.get("sections"):
                    raise ToolError(
                        "Profile extraction failed: no content was extracted."
                    )
        except (AuthenticationError, AccountRestrictedError):
            raise ToolError(
                "Open Neko and complete LinkedIn sign-in or the security check, "
                "then call get_person_profile again."
            ) from None
        except RateLimitError:
            raise ToolError(
                "LinkedIn limited this request. Inspect Neko and wait before retrying."
            ) from None
        except (BrowserBusyError, BrowserConnectionError) as error:
            raise ToolError(str(error)) from None
        except ToolError:
            raise
        except (LinkedInOperationError, Error):
            raise ToolError(
                "Profile extraction failed. Inspect the page in Neko."
            ) from None
        if unknown:
            result["unknown_sections"] = unknown
        return result

    return server
