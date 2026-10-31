# Verification record

## Runtime hardening: metadata-only diagnostic inventory

The approved inventory inspected only filesystem metadata beneath the known upstream trace and issue-report directories on the development host and malt. No diagnostic file contents or screenshots were opened, copied, or deleted. Detailed file paths remain outside this repository and application logs.

| Host | Trace files | PNG files | JSONL files | Total file bytes |
| --- | ---: | ---: | ---: | ---: |
| Development host | 94 | 84 | 10 | 2,260,375 |
| malt | 19 | 17 | 2 | 447,253 |

Neither default issue-report directory contained files at inspection time. This is an inventory of the known default locations, not an exhaustive search of the user's filesystem or proof of the contents of those files. Disposal requires separate approval.

The pinned upstream `mcp-server-linkedin==4.27.0` defaults to `LINKEDIN_TRACE_MODE=on_error`. Its trace capture can write screenshots and page metadata, and an explicit `LINKEDIN_DEBUG_TRACE_DIR` takes precedence over trace mode off. The revised personal-use policy accepts upstream diagnostics; the wrapper does not disable or redact them. The presence of files must not be confused with proof that their contents are harmless, or that the hardening change is implemented.

The inventory used non-content-reading directory traversal and file size metadata, without following directory symlinks. Future inventories must stay scoped to established diagnostic paths; do not open artifacts or delete them as part of verification.

## Historical blocker: trace off does not disable failure reports

An isolated subprocess in the project's Nix Python 3.14 environment set trace mode to `off`, removed the explicit trace directory, and supplied temporary HOME, XDG, and source-profile paths. After creating the wrapper server, it called the pinned upstream `build_issue_diagnostics` inside an async event loop with a synthetic exception and profile URL. No browser or network was used; the helper reported that its GitHub issue search was skipped.

Although `get_trace_dir()` returned `None`, the helper created one Markdown issue report containing the synthetic exception text. The negative assertion that no report should exist failed as expected. Only files created by this isolated reproducer were read and automatically removed; existing diagnostic artifacts were untouched.

The extractor's section-failure path calls this helper, which falls back to an `issue-reports` directory when tracing is disabled. The latest upstream default branch checked, `3e054b38a40278dcdd597defd7c5a24156c75dfb`, retains the same implementation. Disabling trace capture and Python logging alone therefore cannot satisfy the no-diagnostic-files contract.

The reproducer remains evidence of upstream behavior, but the user subsequently removed the no-diagnostic-files requirement in favor of personal-use upstream defaults. This is no longer a blocker. No production workaround, dependency patch, upgrade, or monkey patch has been applied.

## Personal-use diagnostic policy verification

`tests/test_diagnostics.py` runs eight isolated subprocess cases: default, always, off, and explicit-directory-over-off settings, each with trace allocation alone or an async synthetic section failure report. The project's Nix environment reported **8 passed in 7.89s**. These cases create the wrapper server without connecting to a browser and exercise the actual pinned upstream helpers, not mocks. The async report path explicitly confirms that upstream issue search is skipped.

The tests verify directory placement, retention decisions, synthetic report contents, and persistence after subprocess exit. They do not exercise screenshot capture or a full browser extraction; those remain separate browser integration checks. Default trace directories survive because the wrapper does not call upstream logging setup/teardown. Source inspection of `logging_config.py` confirms that upstream registers its cleanup in logging setup and invokes `cleanup_trace_dir()` from teardown, neither of which the wrapper uses.

All generated artifacts are inside temporary test directories, including HOME, XDG, upstream source-profile, and explicit trace paths. Existing user diagnostic files were neither inspected nor deleted. The README now documents permitted sensitive diagnostics and the absence of wrapper retention guarantees.
