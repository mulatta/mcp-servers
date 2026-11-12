# Upstream boundaries

Behaviour of Stalwart that this server depends on. Source statements were
checked against Stalwart 0.15.5 (`stalwart_0_15` in the pinned nixpkgs);
behaviour statements come from the NixOS VM test, which runs that version with
PostgreSQL storage and a Kanidm 1.11 LDAP directory that binds through a Kanidm
application, as planned for the production host.

## Authentication

- HTTP accepts `Basic` (password or app password), `Bearer` OAuth tokens, and
  `Bearer api_…` API keys for the management API only
  (`crates/http/src/auth/authenticate.rs`). This server uses Basic.
- With an LDAP directory and `bind.auth.method = "template"`, Stalwart checks a
  password only by binding to the directory as the person with it
  (`crates/directory/src/backend/ldap/lookup.rs`). It never consults the
  application passwords it stores itself: the VM test created one through
  `/api/account/auth`, saw it listed, and was refused when signing in with it.
  In that test, the refused bind also locked the person's Unix password for a
  while, which is Kanidm's lockout after a failed bind.
- Kanidm application passwords (Kanidm 1.11) authenticate binds whose DN names
  the application (`spn=<person>,app=<application>,<base DN>`); such a bind
  accepts only that application's passwords. Only the person may issue or
  delete them (`idm_acp_self_write`), and the person needs a privileged
  session for it. Stalwart has one bind template, so every password sign-in to
  mail goes through the application.
- Stalwart caches neither Basic sign-ins nor bind results across requests: the
  VM test deletes the server's application password and the next request is
  refused, while the account's other application passwords keep working.
- Failed sign-ins count toward `server.auto-ban.auth.rate` (default `100/1d`)
  per address (`crates/common/src/listener/blocked.rs`), so the server stops
  sending a refused password.
- OAuth (not used): tokens are signed, not stored, and nothing lists or revokes
  them one by one; refresh grants do not check the client's registration.
  Without a fixed `oauth.key`, and with `oauth.*` in `config.local-keys` as on
  the production host, Stalwart generates a new signing key at every start
  and every token stops working.

## Session

- `GET /jmap/session` reports `apiUrl` from `http.url`. The server sends its
  password only to an `apiUrl` on the configured origin and refuses anything else
  with `UPSTREAM_CHANGED`, so `http.url` must match `PIM_SERVER_URL`.
- The session lists `maxExpandedQueryDuration` `P52W1D` for calendars, which
  bounds `pim_search_events` to 365 days.

## Where Stalwart 0.15 departs from the specifications

Each was found by the VM test or the live read check and is covered by a protocol test.

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
| `VacationResponse/get` reports the singleton in `notFound` until the account first sets one; `VacationResponse/set` updates it anyway, creating it | An absent singleton reads as the reply being off |

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
