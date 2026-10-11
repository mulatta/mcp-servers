"""Characterize upstream diagnostics without accessing the user's session."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PROBE = """
import asyncio
import json
import sys
from linkedin_mcp.browser import BrowserSession
from linkedin_mcp.server import create_server
from linkedin_mcp_server.debug_trace import get_trace_dir, should_keep_traces
from linkedin_mcp_server.error_diagnostics import build_issue_diagnostics

create_server(BrowserSession("http://127.0.0.1:1"))
trace = get_trace_dir()

async def main():
    diagnostics = None
    if sys.argv[1] == "error":
        # The async path is the extractor's path and skips GitHub issue search.
        diagnostics = build_issue_diagnostics(
            RuntimeError("synthetic-diagnostic-detail"),
            context="read_person",
            target_url="https://www.linkedin.com/in/synthetic-member/",
            section_name="experience",
        )
        assert diagnostics["issue_search_skipped"]
    print(json.dumps({
        "trace": str(trace) if trace else None,
        "keep": should_keep_traces(),
        "diagnostics": diagnostics,
    }))

asyncio.run(main())
"""


@pytest.mark.parametrize("mode", ["default", "always", "off", "explicit"])
@pytest.mark.parametrize("outcome", ["success", "error"])
def test_upstream_diagnostic_policy(tmp_path: Path, mode: str, outcome: str) -> None:
    env = os.environ.copy()
    # Isolate upstream's legacy paths as well as libraries using XDG directories.
    env["HOME"] = str(tmp_path)
    env["USER_DATA_DIR"] = str(tmp_path / ".linkedin-mcp" / "profile")
    for name in ("CONFIG", "CACHE", "DATA", "STATE"):
        env[f"XDG_{name}_HOME"] = str(tmp_path / name.lower())
    env.pop("LINKEDIN_TRACE_MODE", None)
    env.pop("LINKEDIN_DEBUG_TRACE_DIR", None)
    if mode != "default":
        env["LINKEDIN_TRACE_MODE"] = "off" if mode == "explicit" else mode
    if mode == "explicit":
        env["LINKEDIN_DEBUG_TRACE_DIR"] = str(tmp_path / "explicit-trace")

    process = subprocess.run(
        [sys.executable, "-c", PROBE, outcome],
        env=env,
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
    )
    result = json.loads(process.stdout)
    trace = Path(result["trace"]) if result["trace"] else None
    if mode == "off":
        assert trace is None
    elif mode == "explicit":
        assert trace == tmp_path / "explicit-trace"
    else:
        assert trace is not None
        assert trace.parent == tmp_path / ".linkedin-mcp" / "trace-runs"
        # Importing the extractor is not the upstream server's cleanup lifecycle.
        assert trace.is_dir()

    if outcome == "error":
        report = Path(result["diagnostics"]["issue_template_path"])
        assert report.is_relative_to(tmp_path)
        assert report.parent == (trace or tmp_path / ".linkedin-mcp" / "issue-reports")
        assert "synthetic-diagnostic-detail" in report.read_text()
        assert "https://www.linkedin.com/in/synthetic-member/" in report.read_text()
    else:
        assert result["diagnostics"] is None
        assert not list(tmp_path.rglob("*.md"))
    assert result["keep"] is (
        mode in {"always", "explicit"} or (outcome == "error" and mode != "off")
    )
