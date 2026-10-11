# Upstream boundaries

Verified against installed `youtubei.js` 18.1.0. No personal browser or account
was accessed for this inspection.

## YouTube.js

- `Innertube.create({ cookie, account_index: 0, retrieve_player: false, enable_session_cache: false })` accepts a Cookie header string. No disk cache
  will be supplied. Player retrieval is unnecessary for library reads.
- `dist/src/utils/HTTPClient.js` adds cookies and derives SAPISID authentication.
  `Session.logged_in` is initially just `!!cookie`; it is **not** proof of login.
- `account.getInfo()` calls the read-only accounts-list endpoint using the TV
  client and returns `AccountInfo`. Its parsed `page` retains
  `AccountSectionList.footers`, whose `AccountChannel.endpoint` can identify a
  channel. Accept only an unambiguous `UC...` browse ID from that account page;
  fail closed if absent. Do not use display names, cookie hashes, or mutable
  handles as stable identity. Actual account compatibility remains unverified.
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
`parser/classes/AccountSectionList.js`, and `parser/classes/AccountChannel.js`.

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
