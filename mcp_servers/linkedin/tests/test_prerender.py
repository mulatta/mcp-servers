"""Pin why shared browsers must disable prerendering before CDP attach."""

import json
import os
import threading
import urllib.request
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import anyio
import pytest
from linkedin_mcp.browser import BrowserConnectionError, BrowserSession
from websockets.asyncio.client import ClientConnection, connect

pytestmark = pytest.mark.skipif(
    bool(os.environ.get("TEST_CDP_URL")),
    reason="Prerender settings require a test-owned browser",
)

PAGES = {
    "/host": '<script type="speculationrules">'
    '{"prerender":[{"source":"list","urls":["/activated"]}]}</script>'
    '<script>setTimeout(() => { location.href = "/activated"; }, 1500)</script>',
    "/activated": "<title>Activated</title>",
}


class Pages(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(PAGES.get(self.path, "").encode())

    def log_message(self, *args: Any) -> None:
        pass


@pytest.fixture
def site() -> Iterator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Pages)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()


async def call(ws: ClientConnection, message_id: int, **message: Any) -> Any:
    await ws.send(json.dumps({"id": message_id, **message}))
    while True:
        reply = json.loads(await ws.recv())
        if reply.get("id") == message_id:
            return reply["result"]


async def activated_tab(endpoint: str, site: str) -> str:
    # A tab created without DevTools attached can prerender, unlike Playwright's own tabs.
    request = urllib.request.Request(f"{endpoint}/json/new?{site}/host", method="PUT")
    await anyio.to_thread.run_sync(lambda: urllib.request.urlopen(request).read())
    with anyio.fail_after(10):
        while True:
            raw = await anyio.to_thread.run_sync(
                lambda: urllib.request.urlopen(f"{endpoint}/json/list").read()
            )
            for target in json.loads(raw):
                if target["type"] == "page" and target["url"] == f"{site}/activated":
                    return str(target["id"])
            await anyio.sleep(0.1)


async def main_frame_matches_target(websocket: str, target_id: str) -> bool:
    async with connect(websocket, max_size=None) as ws:
        session = await call(
            ws,
            1,
            method="Target.attachToTarget",
            params={"targetId": target_id, "flatten": True},
        )
        tree = await call(
            ws, 2, method="Page.getFrameTree", sessionId=session["sessionId"]
        )
        return bool(tree["frameTree"]["frame"]["id"] == target_id)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("chromium", "prerender"),
    [
        pytest.param((), True, id="default"),
        pytest.param(("--disable-features=Prerender2",), False, id="disabled"),
    ],
    indirect=["chromium"],
)
async def test_prerender_activation_blocks_cdp_attach(
    chromium: tuple[str, str], site: str, prerender: bool
) -> None:
    endpoint, websocket = chromium
    target_id = await activated_tab(endpoint, site)
    assert await main_frame_matches_target(websocket, target_id) is not prerender
    session = BrowserSession(endpoint)
    try:
        if prerender:
            # Patchright keys the main frame by target id and waits forever for a
            # first commit (microsoft/playwright#41397). If this starts passing,
            # the Neko Prerender2 workaround may be unnecessary.
            with pytest.raises(BrowserConnectionError):
                async with session.lease():
                    pass
        else:
            async with session.lease() as page:
                assert not page.is_closed()
    finally:
        await session.close()
