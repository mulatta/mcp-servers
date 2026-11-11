# Upstream boundaries

Behaviour of Stalwart that this server depends on. Source statements were
checked against Stalwart 0.15.5 (`stalwart_0_15` in the pinned nixpkgs);
behaviour statements come from the NixOS VM test, which runs that version with
PostgreSQL storage, the internal directory and registered OAuth clients only.

## Authentication

- HTTP accepts `Basic` (password or app password), `Bearer` OAuth tokens, and
  `Bearer api_…` API keys for the management API only
  (`crates/http/src/auth/authenticate.rs`). With an LDAP directory, Basic
  authenticates against the directory's own password, so this server uses
  OAuth instead.
- Device authorization: `POST /auth/device` with `client_id`; Stalwart answers
  `device_code`, `user_code`, `verification_uri` (`<origin>/authorize`),
  `verification_uri_complete`, `expires_in` (`oauth.expiry.user-code`, 30
  minutes) and `interval` 5. Polling `POST /auth/token` with grant
  `urn:ietf:params:oauth:grant-type:device_code` answers 400
  `authorization_pending` until approved, then an access and a refresh token.
- The web admin approves a code with `POST /api/oauth`
  `{"type":"device","code":"<user code>"}` as the signed-in account; the VM
  test uses this to stand in for the operator's browser.
- `oauth.client-registration.require = true` makes Stalwart check, when it
  issues the token, that the client ID is a registered `oauthClient`
  principal.
- Expiry (`crates/common/src/auth/oauth/config.rs`): access tokens 1 hour,
  refresh tokens 30 days. A `refresh_token` grant returns a new refresh token
  only when the old one has at most `oauth.expiry.refresh-token-renew` (4 days)
  left (`crates/http/src/auth/oauth/token.rs`); otherwise the answer has no
  `refresh_token` and the old one stays in use.
- Tokens are signed, not stored: validation checks the signature, expiry and,
  for tokens longer than an hour, a hash of the account secret. A rotated
  refresh token therefore stays valid until it expires, and a password change
  revokes refresh tokens only if the directory's secret changes with it.
- Stalwart does not enforce OAuth scopes: the issued token carries no scope
  and authorizes everything the account may do.
- Refresh tokens contain `+` and `/`; form bodies must be URL-encoded.

## Session

- `GET /jmap/session` reports `apiUrl` from `http.url`. The server sends its
  token only to an `apiUrl` on the configured origin and refuses anything else
  with `UPSTREAM_CHANGED`, so `http.url` must match `PIM_SERVER_URL`.
- The session lists `maxExpandedQueryDuration` `P52W1D` for calendars, which
  bounds `pim_search_events` to 365 days.

## Where Stalwart 0.15 departs from the specifications

Each was found by the VM test and is covered by a protocol test.

| Behaviour | Effect on this server |
| --- | --- |
| `Email/query` and `ContactCard/query` reject `filter: null` with `invalidArguments` | Searches without conditions omit `filter` |
| `CalendarEvent/get` on an event read directly reports the event's own ID as `baseEventId`; expanded occurrences report the series | `base_event_id` is null when it equals the event, and only a different base marks an occurrence |
| Recurrence expansion needs both `after` and `before` and at most `P52W1D` | `pim_search_events` requires both, at most 365 days apart |
| `SieveScript/set` resolves blob creation IDs (`#script`) but `SieveScript/validate` does not (`blobNotFound`) | Validation uploads first, then validates the returned blob ID |
| The set answer does not report which Sieve script became active | Activation reads the scripts back in the same request |
| Contact name and text search use name components only, not `name.full`, and match whole words | Contacts are written with given-name and surname components |
| Identities are created on first `Identity/get` only for addresses that pass `sanitize_email`, which checks the public suffix list | Test accounts use a reserved domain with a real suffix (`example.org`) |
| A delivered message whose Message-ID the account already holds is skipped as a duplicate | Mail sent to the account itself never reaches its Inbox; tests send to a second account |
| Text search reads the search index, written shortly after an object | Tests poll; descriptions warn that new items appear in text searches after a moment |
| Missing calendar properties are omitted rather than null | Event schemas treat them as optional |

## Calendars and scheduling

- `CalendarEvent/set` takes `sendSchedulingMessages`, default `false` over JMAP
  (`crates/jmap/src/calendar_event/set.rs`), and sends iTIP only when it is true
  and the event has participants. This server always sends `false` and refuses
  events with participants regardless, since other clients (CalDAV) may still
  schedule.

## Packaging used by the VM test

| Issue | Upstream status (2026-11-11) | What the test does |
| --- | --- | --- |
| `stalwart_0_15` fails to build: nixpkgs' cargo setup links jemalloc from the system | NixOS/nixpkgs#586026 open | Adds `rust-jemalloc-sys` to `buildInputs`, as the production host does |
| With that override, RocksDB crashes in `malloc_usable_size` | Follows from the override | Uses PostgreSQL storage, as the production host does |
| The web admin bundle's build tool (`trunk`) fails on the pinned nixpkgs | NixOS/nixpkgs#584299 merged to master, not yet in nixos-unstable | Points `webadmin.resource` at a missing file |

Revisit these rows when the flake's nixpkgs moves; drop each workaround once
its fix is in the pinned revision.
