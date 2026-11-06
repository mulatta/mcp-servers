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

## Neko synthetic background focus probe

With explicit approval and the user watching the Neko screen, a standalone Patchright probe connected through the existing development CDP tunnel. It used the existing default browser context, not a new context or browser. Queue task 505 completed successfully; protocol checks took 35.13 seconds. No LinkedIn lookup, browser restart, screen capture, or existing diagnostic-file inspection occurred.

The probe created one target using `Target.createTarget` with `background: true`, then matched it to a Patchright Page by comparing the returned target ID with `Target.getTargetInfo`. It did not select a page by URL, position, or first page event. The Page navigated to a synthetic data URL, clicked a button, and scrolled using `window.scrollTo`. Button-count and scroll-position assertions passed. After a pause for user interaction, a second click and scroll also passed.

The user independently observed the browser UI: while starting on tab A, they opened tab B, worked there, and returned to A. They saw the synthetic test tab appear in the tab strip, but their selected tab never lost focus to it. This is human UI evidence, not a conclusion from `document.hasFocus()` or another focus-emulated DOM value. The probe used neither foreground activation nor retrospective focus restoration.

Cleanup closed only the exact target ID returned to the probe. Subsequent target enumeration confirmed that it was gone, all pre-existing page targets remained, and the browser connection was still alive. The probe disconnected its driver without closing the shared browser or context.

This is a successful single synthetic compatibility check, not verification of the production wrapper's planned lease lifecycle. It does not cover initialization failure, cancellation, admission, deadline or cleanup-failure recovery, nor real upstream extraction or screenshot capture. The user's additional tab exercised concurrent browser use, but did not establish a deterministic race during target-to-Page matching. At this point, automated race/failure tests and verification against the implemented lease remained outstanding; no implementation task was marked complete from this probe alone.

## Background target ownership regression

The next implementation step adds background creation to `BrowserSession` without yet changing its reusable-tab lifetime. It records the returned target ID before waiting for a Page and closes that exact target on initialization failure or cancellation. Cleanup polls for target disappearance because `Target.closeTarget` can acknowledge before destruction is visible.

`tests/test_background.py` uses an actual test-owned Chromium and a WebSocket relay, not mocked Page or browser objects. It checks three cases: a user-created tab arriving before the creation response is delivered, a real Chromium unsupported-method error injected during page initialization, and cancellation while the initialization protocol message is held. The relay also asserts the explicit background parameter and absence of foreground activation commands. Existing targets and the concurrent user tab must survive; test teardown removes only targets owned by the test. Fault injection is skipped for shared-browser endpoints.

The initial regression run exposed the missing background flag and cancellation delayed by the old connection-wide shield. After implementation, all three cases passed. The complete suite on local **headed Chromium 129.0.6668.29**, using the project's Nix environment and pinned Patchright, reported **34 passed, 1 skipped in 77.51s**. The skipped case was the opt-in real-profile lookup; no shared Neko or LinkedIn lookup was used in this run. Ruff format/check and strict mypy passed. Set `TEST_HEADED=1` with `TEST_CHROMIUM` to reproduce the headed test mode.

This establishes exact background target ownership and initialization cleanup, not the later request-scoped lease or blocked-cleanup recovery contract. Creation-response loss, complete operation/cleanup deadlines, and cleanup-failure retention remain subsequent tasks. The earlier Neko user observation is separate evidence; these automated checks do not infer visible focus from JavaScript state.

## Request-scoped tab leases

`BrowserSession.lease()` now separates the healthy connection lifetime from each request's target lifetime. The lease regressions first failed because the previous implementation kept successful request tabs open. After the change, sequential requests use different target IDs on the same Browser and driver objects; successful, failed, and cancelled requests close their tabs while retaining a healthy connection. The observer verifies that user tabs and the external browser survive final session shutdown.

Existing browser, authentication, extraction, and disconnect tests now use leases. DOM fixtures route only the current owned Page's requests, leaving unrelated pages and service workers alone. The live test now requires request-tab closure before stdio transport shutdown; this live assertion was updated but not executed without a fresh real-profile authorization.

The complete local headed suite reported **37 passed, 1 skipped in 104.79s**. Ruff format/check and strict mypy passed. No real LinkedIn request was made. Admission limits, the complete deadline policy, cleanup-failure retention, and focus observation of the implemented lease remain pending.

## Neko connection blocker: prerender-activated tabs

The first attempt to observe the implemented lease on Neko Chrome 154 never reached tab creation. Patchright `connect_over_cdp` timed out after the WebSocket connected, so the wrapper would have reported a generic `BrowserConnectionError` for every request. The SSH forward, discovery, and Chrome's CDP responses were healthy: every command Patchright sent received a reply.

A temporary instrumented copy of the pinned Patchright driver showed that every target initialized except one existing user tab. Its main frame id differed from its target id. Patchright keys the main frame session by target id, so the initial frame tree was discarded as stale, the main frame URL stayed empty, and initialization waited forever for a first navigation commit. This matches microsoft/playwright#41397, closed as not planned: a tab that activated a prerendered document has this id mismatch. Playwright's own launches avoid it because Chrome disables prerendering in tabs that DevTools controls, while Neko tabs opened by the user are not attached.

Chromium 129, used by the local suite, kept the frame id after a speculation-rules prerender activation, so no automated regression reproduces the mismatch yet. The malt Neko Chromium now runs with `--disable-features=Prerender2`; no other `--disable-features` switch existed for it to override. After deployment, the restored tabs connected in 2.7 seconds. This is an operational prerequisite of the shared browser, not a wrapper workaround, and it does not repair Patchright's handling of such tabs.

## Neko focus observation of the implemented lease

With approval and the user watching the Neko screen, a synthetic probe used `BrowserSession.lease()` through the development CDP forward. Queue task 533 completed in 91 seconds. No LinkedIn request, screen capture, or diagnostic-file inspection occurred.

The first lease created its background tab, navigated to a synthetic data URL, clicked, and scrolled with `window.scrollTo`, `mouse.wheel`, and `scroll_into_view_if_needed`; the wheel also moved the page while the tab was in the background. The probe then waited while the user opened another tab, worked there, returned, and clicked the synthetic tab's button directly. Afterward the probe's own click raised the counter from 9 to 10, confirming exactly one automated click alongside user input. Closing the lease removed its exact target. A second lease received a different target ID, navigated, clicked, and closed. No page present at the start disappeared, and the browser connection stayed alive after session close.

The user saw the synthetic tabs appear in and leave the tab strip, and reported that the selected tab never switched to the synthetic tab without their own selection during creation, navigation, clicks, scrolling, closing, or the second lease. This human observation, not a focus-emulated DOM value, is the acceptance evidence. An earlier run of the same probe asserted an exact counter value and failed only because the requested user interaction also clicked the button; its cleanup still removed the owned tab.

This verifies the implemented lease with synthetic pages. It does not cover real LinkedIn extraction, admission, deadlines, or cleanup-failure recovery, which remain later tasks.
