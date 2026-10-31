import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

import pytest
from linkedin_mcp.browser import BrowserConnectionError, BrowserSession
from patchright.async_api import Error, Page, async_playwright


class Relay:
    """Drop only sockets opened by this test, never the upstream listener."""

    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self.writers: set[asyncio.StreamWriter] = set()
        self.tasks: set[asyncio.Task[None]] = set()

    async def serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.writers.add(writer)
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection(
                self.host, self.port
            )
            self.writers.add(upstream_writer)
            try:

                async def copy(
                    source: asyncio.StreamReader, target: asyncio.StreamWriter
                ) -> None:
                    try:
                        while chunk := await source.read(65536):
                            target.write(chunk)
                            await target.drain()
                    except (ConnectionError, OSError):
                        pass
                    finally:
                        target.close()

                await asyncio.gather(
                    copy(reader, upstream_writer), copy(upstream_reader, writer)
                )
            finally:
                upstream_writer.close()
                self.writers.discard(upstream_writer)
        finally:
            writer.close()
            self.writers.discard(writer)

    def accept(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.create_task(self.serve(reader, writer))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    def drop(self) -> None:
        for writer in list(self.writers):
            writer.close()


@asynccontextmanager
async def relay_for(websocket: str) -> AsyncIterator[tuple[Relay, str]]:
    parsed = urlsplit(websocket)
    assert parsed.hostname is not None
    relay = Relay(parsed.hostname, parsed.port or 80)
    async with await asyncio.start_server(relay.accept, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        try:
            yield relay, f"ws://127.0.0.1:{port}{parsed.path}"
        finally:
            relay.drop()
            if relay.tasks:
                await asyncio.wait_for(asyncio.gather(*relay.tasks), timeout=5)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["idle", "in-flight", "swallowed", "translated"])
async def test_disconnect_reconnect(chromium: tuple[str, str], mode: str) -> None:
    async with (
        async_playwright() as observer,
        relay_for(chromium[1]) as (relay, endpoint),
    ):
        browser = await observer.chromium.connect_over_cdp(chromium[0])
        context = browser.contexts[0]
        originals = list(context.pages)
        session = BrowserSession(endpoint)
        orphan: Page | None = None
        try:
            async with context.expect_page() as created, session.lease() as page:
                await page.set_content("<title>Disposable relay test</title>")
            orphan = await created.value
            if mode != "idle":
                started = asyncio.Event()
                calls = 0

                async def request() -> None:
                    nonlocal calls
                    async with session.lease() as page:
                        calls += 1
                        started.set()
                        try:
                            await page.wait_for_function("() => false", timeout=10000)
                        except Error:
                            if mode == "swallowed":
                                return
                            if mode == "translated":
                                raise ValueError(
                                    "Extractor reported missing content"
                                ) from None
                            raise

                async with context.expect_page() as in_flight:
                    task = asyncio.create_task(request())
                    await started.wait()
                orphan = await in_flight.value
                relay.drop()
                with pytest.raises(BrowserConnectionError, match="CDP connection"):
                    await asyncio.wait_for(task, timeout=10)
                assert calls == 1
            else:
                relay.drop()
                assert session._browser is not None
                async with asyncio.timeout(10):
                    while session._browser.is_connected():
                        await asyncio.sleep(0.01)
            async with session.lease() as page:
                await page.set_content("<main>Reconnected</main>")
                assert await page.locator("main").inner_text() == "Reconnected"
            assert browser.is_connected()
            assert all(not page.is_closed() for page in originals)
        finally:
            await session.close()
            # Only this exact test-created handle is eligible for orphan cleanup.
            if orphan is not None and not orphan.is_closed():
                await orphan.close()


@pytest.mark.asyncio
async def test_discovery_success_then_websocket_failure() -> None:
    requests: list[str] = []

    async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            path = request.split(b" ")[1].decode()
            requests.append(path)
            port = writer.get_extra_info("sockname")[1]
            if path == "/json/version/":
                body = json.dumps(
                    {"webSocketDebuggerUrl": f"ws://127.0.0.1:{port}/unavailable"}
                ).encode()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
                    + body
                )
            else:
                writer.write(
                    b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async with await asyncio.start_server(serve, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        session = BrowserSession(f"http://127.0.0.1:{port}")
        try:
            with pytest.raises(BrowserConnectionError, match="discovery.*relay"):
                async with session.lease():
                    pytest.fail("Unavailable WebSocket must not connect")
            assert requests == ["/json/version/", "/unavailable"]
            assert session.page is None
            assert session._driver is None
        finally:
            await session.close()


@pytest.mark.asyncio
async def test_connection_error_hides_secrets(
    capsys: pytest.CaptureFixture[str],
) -> None:
    async def refuse(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.close()
        await writer.wait_closed()

    async with await asyncio.start_server(refuse, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        session = BrowserSession(
            f"ws://private-user:private-password@127.0.0.1:{port}/?token=private-token"
        )
        try:
            with pytest.raises(BrowserConnectionError) as caught:
                async with session.lease():
                    pytest.fail("Refusing server must not connect")
            output = capsys.readouterr()
            assert not output.out
            for secret in ["private-user", "private-password", "private-token"]:
                assert secret not in str(caught.value) + output.err
            assert "discovery" in str(caught.value)
            assert "relay" in str(caught.value)
        finally:
            await session.close()
