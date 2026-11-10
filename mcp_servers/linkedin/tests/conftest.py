from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio


@pytest_asyncio.fixture
async def chromium(
    tmp_path: Path, request: pytest.FixtureRequest
) -> AsyncIterator[tuple[str, str]]:
    # Shared browsers are opt-in and never started or stopped by this fixture.
    endpoint = os.environ.get("TEST_CDP_URL")
    if endpoint:
        websocket = os.environ.get("TEST_CDP_WS_URL")
        if not websocket:
            pytest.fail(
                "Set TEST_CDP_WS_URL from the endpoint's /json/version response"
            )
        yield endpoint, websocket
        return
    executable = os.environ.get("TEST_CHROMIUM")
    if not executable:
        pytest.fail("Set TEST_CHROMIUM to a local Chromium executable")
    process = await asyncio.create_subprocess_exec(
        executable,
        *([] if os.environ.get("TEST_HEADED") == "1" else ["--headless=new"]),
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        f"--user-data-dir={tmp_path / 'profile'}",
        "--no-first-run",
        "--no-default-browser-check",
        *getattr(request, "param", ()),
        "about:blank",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        endpoint_file = tmp_path / "profile" / "DevToolsActivePort"
        async with asyncio.timeout(20):
            while not endpoint_file.exists():
                if process.returncode is not None:
                    _, errors = await process.communicate()
                    pytest.fail(f"Chromium exited before CDP started: {errors!r}")
                await asyncio.sleep(0.05)
        port, path = endpoint_file.read_text().splitlines()[:2]
        yield f"http://127.0.0.1:{port}", f"ws://127.0.0.1:{port}{path}"
        assert process.returncode is None, (
            "Client shutdown terminated external Chromium"
        )
    finally:
        if process.returncode is None:
            process.terminate()
        await asyncio.wait_for(process.communicate(), timeout=10)
