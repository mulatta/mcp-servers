# Upstream boundaries

Verified against installed `youtubei.js` 18.1.0. No personal browser or account
was accessed for this inspection.

## YouTube.js

- `Innertube.create({ cookie, account_index: 0, retrieve_player: false, enable_session_cache: false })` accepts a Cookie header string. No disk cache
  will be supplied. Player retrieval is unnecessary for library reads.
- `dist/src/utils/HTTPClient.js` adds cookies and derives SAPISID authentication.
  `Session.logged_in` is initially just `!!cookie`; it is **not** proof of login.
- `account.getInfo()` uses the TV accounts-list endpoint, but channel footers
  are optional. A public MediaServiceCore accounts-list fixture has no footer.
  Do not assume that method provides a stable channel ID.
- Identity uses a fixed read-only `/browse` request for `SPaccount_advanced`,
  parsed by YouTube.js. Accept exactly one distinct `UC` plus 22-character ID
  from `CopyLink.short_url`; fail closed if absent or ambiguous. This settings
  read is documented in upstream issue #783. Do not use display names, cookie
  hashes, mutable handles, or account-switch tokens as identity. Accounts
  without an identifiable channel fail safely. The approved live smoke check
  verified this identity read on one account, not universal compatibility.
- Generate session context locally and disable Innertube config/player
  retrieval. This avoids unrelated bootstrap requests and lets transport
  restrict authenticated traffic to the fixed YouTube browse endpoint.
- `account.getInfo(true)` lists accounts using WEB and has `is_selected`, but
  `AccountItem` does not expose a stable channel ID as a dedicated field. Do not
  execute switch-account service endpoints to derive identity.
- `Log.setLevel(Log.Level.NONE)` disables upstream console diagnostics before
  constructing a client. Do not return raw errors, request bodies, or headers.
- `getPlaylists()`, `getPlaylist("WL")`, `getPlaylist("LL")`, and `getHistory()`
  provide read surfaces. Continuation processing must preserve remaining items.

Local source references are under `node_modules/youtubei.js/dist/src/`:
`core/Session.js`, `core/managers/AccountManager.js`, `utils/HTTPClient.js`,
`utils/Log.js`, `parser/youtube/AccountInfo.js`,
`parser/classes/AccountSectionList.js`, `parser/classes/AccountChannel.js`,
`parser/classes/SettingsOptions.js`, and `parser/classes/CopyLink.js`.

Latest upstream inspected: `bad89d2657e88f907011655f199fba9fb615c339`
(`main`). AccountItem still has no dedicated immutable channel-ID property.
Issue <https://github.com/LuanRT/YouTube.js/issues/783> is a closed historical
accounts-list 400 report, not proof of a current regression or released fix.
The settings fixture used here is source-derived and synthetic, not captured
personal account data. Library fixture provenance is documented under
`tests/fixtures/library/README.md`.

The approved live check exposed local normalization gaps already handled by
installed 18.1.0 and the inspected upstream commit:

- `ContinuationItemView` wraps a `continuationCommand` navigation endpoint.
  Upstream PR #1193 is merged; installed source includes that class.
- `NavigationEndpoint` unwraps `innertubeCommand` and supports command-executor
  bundles (merged PR #968). Our adapter extracts only the single browse token;
  it never executes other commands embedded in a response.
- `ReelShelf.items` and `ShortsLockupView.onTap` / `overlayMetadata` describe
  history Shorts. Normalize them in place to retain order and date grouping.

Shape-only live observations became synthetic regression cases in
`tests/protocol/modern-layouts.test.ts`. No live response bodies, identifiers,
or credential-bearing payloads were copied into fixtures. No dependency
upgrade or upstream patch was required.

## Chromium CDP

Reference: <https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getCookies>.

Use the browser WebSocket from `/json/version`, then:

1. `Target.getTargets` and `Target.getBrowserContexts` to exclude non-default
   browser contexts; select an existing page without navigating it.
1. `Target.attachToTarget` with `flatten: true`.
1. `Network.getCookies` on that session with the fixed URL
   `https://www.youtube.com/` (includes HttpOnly cookies).
1. `Target.detachFromTarget`, then close only the CDP connection.

No browser launch, page creation, JavaScript evaluation, cookie mutation, or
browser shutdown commands are needed. No default-context page means a safe
browser-unavailable failure, not an automatic tab creation.

`YOUTUBE_CDP_URL` is operator configuration, never an MCP argument. Discovery
redirects and mismatched WebSocket authorities are rejected. Discovery's
loopback hostname/port can be rewritten to the operator's authority for SSH or
container port forwarding; paths remain under `/devtools/browser/`.

Even URL-scoped CDP results are filtered for exact cookie applicability and
header safety. Partitioned cookies require a matching YouTube top-level site
and no cross-site ancestor; opaque or unknown partition keys are discarded.
Expired cookies and unrelated domains/paths never enter the session header.
No profile database or cookie export file is read or written.

The CDP connection itself grants full browser authority. A restricted adapter
is not a credential vault or a substitute for host/network isolation.
