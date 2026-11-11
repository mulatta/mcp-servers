# PIM MCP

MCP server for one Stalwart account, written in Bun and TypeScript. It reads
the account's mail, calendars, contacts, vacation reply and Sieve filters over
JMAP and, when enabled per group, changes them. It signs in once with an OAuth
device login; only the refresh token is stored. The server speaks MCP over
stdio or authenticated HTTP.

- Reads are always available. Writes are off unless `PIM_WRITES` names their
  group; drafting and sending are separate groups.
- Stalwart does not enforce OAuth scopes: the token can do whatever the account
  can, so the write groups are the only restriction this server adds.
- [UPSTREAM.md](UPSTREAM.md) records the Stalwart behaviour the server depends
  on, including where Stalwart 0.15 departs from the JMAP specifications.
- [DEVELOPMENT.md](DEVELOPMENT.md) covers the development shell, the protocol
  tests, the NixOS VM test against a real Stalwart, and live checks.

## Configuration

| Variable | Default | Meaning |
| ------------------------ | ------------------------------- | --------------------------------------------------------- |
| `PIM_SERVER_URL` | required | Origin of the Stalwart HTTP listener, such as `https://mail.example.org` |
| `PIM_CLIENT_ID` | `pim-mcp` | OAuth client ID registered in Stalwart |
| `PIM_STATE_DIR` | see below | Directory of the token file |
| `PIM_WRITES` | unset (read-only) | Write groups to expose, see [Writes](#writes) |
| `PIM_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `PIM_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PIM_HTTP_PORT` | required for HTTP | TCP port, 1–65535 |
| `PIM_HTTP_TOKEN_FILE` | required for HTTP | File holding the bearer token on one line |
| `PIM_HTTP_HOST` | `127.0.0.1` | Listen address |
| `PIM_HTTP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated hostnames accepted in `Host` |

`PIM_SERVER_URL` must be a bare HTTPS origin; plain HTTP is accepted only for
`localhost`, `127.0.0.1` and `[::1]`. The token directory is `PIM_STATE_DIR`,
else the first entry of systemd's `STATE_DIRECTORY`, else
`$XDG_STATE_HOME/pim-mcp`, else `~/.local/state/pim-mcp`.

Any invalid value logs `config.invalid` with a fixed code (`INVALID_LOG_LEVEL`,
`INVALID_SERVER`, `INVALID_TRANSPORT`, `INVALID_HTTP_CONFIG`, `INVALID_WRITES`)
and exits 1 before serving. The flakelet module exposes the same settings as
`serverUrl`, `clientId`, `listenAddress`, `port`, `allowedHosts`, `tokenFile`,
`logLevel` and `writes`.

## Signing in

The server uses Stalwart's OAuth 2.0 device authorization (RFC 8628) for the
client in `PIM_CLIENT_ID`. Register that client in Stalwart first (a principal
of type `oauthClient`); with `oauth.client-registration.require = true`
Stalwart refuses unregistered clients.

1. Run `pim-mcp login` with the same `PIM_SERVER_URL` and state directory as
   the server. It prints an address and a code.
1. Open the address, sign in to Stalwart as the account the server should use,
   and approve the code. The code expires after 30 minutes.
1. Login writes `token.json` to the state directory and names the account it
   signed in. A running server picks it up on its next request; no restart is
   needed.

With the flakelet module, the login is a unit of its own, run once after
deployment and again whenever the server reports `AUTH_REQUIRED`:

```sh
sudo systemctl start --no-block pim-mcp-login.service
journalctl -fu pim-mcp-login.service   # shows the address and code
```

It runs as the server's dynamic user with the same state directory
(`/var/lib/private/pim-mcp`), so the server can read the token it writes.

### Tokens

- Access tokens last one hour and live only in memory; the server refreshes one
  a minute before it expires.
- The refresh token lasts 30 days. Stalwart issues a new one only when a
  refresh happens in the old one's last four days, so the server refreshes at
  start and every 24 hours, and an idle server stays signed in.
- A refresh request in progress is shared: the daily refresh, a request that
  found its token expired and a retry after a 401 send one exchange.
- A new refresh token replaces `token.json` atomically: it is written to a
  temporary file (mode 0600) in the same directory, flushed, renamed over the
  old file and the directory flushed. A process killed at any point leaves the
  old or the new token, never a partial file.
- If that save fails, the server keeps working: Stalwart keeps accepting the
  previous refresh token until it expires. The failure is logged as
  `state.write_failed` with code `STATE_WRITE_FAILED`, and every later refresh
  tries the save again.

### When the sign-in ends

| Situation | Result |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| No token file, or one for another server or client | Every tool returns `AUTH_REQUIRED`; nothing is sent |
| Stalwart refuses the refresh token (expired, revoked) | `AUTH_REQUIRED`; the token file is read again on the next call |
| Stalwart is unreachable or answers 5xx on refresh | `UPSTREAM_UNAVAILABLE`; the token is kept |
| A JMAP request answers 401 | One refresh and one resend; a second 401 is `AUTH_REQUIRED` |

There is no automatic re-login: only an operator can approve a device code.

To revoke the server's access, stop it and delete `token.json`, remove the
account's access to mail, or rotate Stalwart's OAuth signing key. Changing the
account password revokes refresh tokens only when Stalwart's directory exposes
a password hash; a directory that maps the secret to a fixed attribute does not.

## Run over stdio

From `mcp_servers/pim`, with `PIM_SERVER_URL` set, run `bun run start`.
Configure an MCP client with command `bun`, arguments `run src/index.ts`, and
the absolute path of `mcp_servers/pim` as working directory. Stdout carries only
MCP messages; diagnostics go to stderr. Tool discovery needs no sign-in.

## Run over HTTP

```sh
PIM_TRANSPORT=http \
PIM_HTTP_PORT=8766 \
PIM_HTTP_TOKEN_FILE=/run/credentials/pim-mcp/token \
PIM_SERVER_URL=https://mail.example.org \
bun run start
```

The server answers stateless Streamable HTTP at `/mcp`, with the same checks as
the YouTube server: `Host` against the allowlist (403), `Authorization: Bearer`
in constant time (401), path (404) and method `POST` (405). The token must be at
least 32 visible ASCII characters; generate it with `openssl rand -hex 32`. Every
response carries `Connection: close`. Keep the listener on loopback and put TLS
in front.

## Read tools

| Tool | Returns | Required input |
| ------------------------ | ----------------------------------------------------- | -------------- |
| `pim_list_mailboxes` | Mailboxes with role, parent and counts | None |
| `pim_search_emails` | Email summaries, newest first | None |
| `pim_get_email` | One email: headers, readable body, attachment metadata | `email_id` |
| `pim_get_thread` | A conversation's summaries, oldest first | `thread_id` |
| `pim_list_identities` | Addresses the account may send as | None |
| `pim_list_calendars` | Calendars and the default one | None |
| `pim_search_events` | Event occurrences in a time range | `after`, `before` |
| `pim_get_event` | One event with description, rules and participants | `event_id` |
| `pim_list_address_books` | Address books and the default one | None |
| `pim_search_contacts` | Contact summaries | None |
| `pim_get_contact` | One contact with notes and the whole JSContact card | `contact_id` |
| `pim_get_vacation` | Vacation reply state, dates, subject and text | None |
| `pim_list_sieve_scripts` | Sieve scripts and which one is active | None |
| `pim_get_sieve_script` | One script with its source | `script_id` |

IDs are opaque JMAP IDs from earlier results. Search tools take `limit` and
`cursor`; keep the other inputs unchanged when passing `next_cursor`. A cursor
is the next position bound to the inputs, not a snapshot.

- Email summaries carry `flags` (`seen`, `flagged`, `answered`, `draft`),
  `tags` and other `keywords`. `pim_search_emails` filters by `mailbox_id`,
  `text`, `from`, `to`, `subject`, `after`, `before`, `tag`, `unread`, `flagged`
  and `has_attachment`.
- **Tags** are Bulwark webmail labels, stored as the keyword `$label:<id>`. Only
  the ID is shown; tag names and colours live in Bulwark's own settings.
- `pim_get_email` returns the text body cut at `max_body_bytes` (default 20000).
  An HTML-only body is converted to plain text; attachment contents are not
  returned.
- `pim_search_events` needs both ends of a range at most 365 days apart and
  lists each occurrence of a recurring event with its own `event_id`; the
  series is `base_event_id`. `utc_start` and `utc_end` are computed by Stalwart.
- Contact search matches whole words; name search covers given names and
  surnames, not display names.

## Writes

`PIM_WRITES` is a comma-separated subset of the groups below, or `all` on its
own. Unset or empty keeps the server read-only; anything else refuses to start
with `INVALID_WRITES`. A tool whose group is off is neither listed nor callable.

| Group | Tools | Destructive |
| ---------- | ------------------------------------------------------------------------------- | ----------- |
| `flag` | `pim_set_email_flags` (seen, flagged, add or remove tags) | No |
| `organize` | `pim_move_emails`, `pim_add_emails_to_mailbox`, `pim_remove_emails_from_mailbox`, `pim_create_mailbox`, `pim_update_mailbox` | No |
| `organize` | `pim_delete_mailbox` (empty mailboxes only) | Yes |
| `delete` | `pim_trash_emails` | No |
| `delete` | `pim_destroy_emails` (only mail solely in Trash or Junk) | Yes |
| `draft` | `pim_create_draft`, `pim_update_draft` | No |
| `draft` | `pim_delete_draft` | Yes |
| `send` | `pim_send_draft`, `pim_send_email` | No |
| `sieve` | `pim_validate_sieve_script`, `pim_save_sieve_script`, `pim_activate_sieve_script` | No |
| `sieve` | `pim_delete_sieve_script` | Yes |
| `vacation` | `pim_set_vacation` | No |
| `calendar` | `pim_create_event`, `pim_update_event` | No |
| `calendar` | `pim_delete_event` | Yes |
| `contact` | `pim_create_contact`, `pim_update_contact` | No |
| `contact` | `pim_delete_contact` | Yes |

### How a write behaves

Each tool's description states its own caveats, because some clients (Hermes)
pass only descriptions and error messages to the model.

- **Sent once.** A write is never retried, except after a 401, which Stalwart
  answers before running anything.
- **Confirmed by Stalwart's answer.** A change counts only when the `/set`
  answer lists it as created, updated or destroyed. A refusal maps to a fixed
  code; an answer that neither confirms nor refuses, a 5xx, a dropped
  connection, a timeout or a cancellation after sending is
  `WRITE_OUTCOME_UNKNOWN`: read the target before trying again. Batch tools
  return the confirmed IDs and `failed` entries with codes; a batch where
  nothing was confirmed is an error.
- **Drafts are not mail.** The `draft` group creates, replaces and deletes only
  messages with `$draft` in the Drafts mailbox (`NOT_A_DRAFT` otherwise) and
  never reaches `EmailSubmission`. Emails are immutable in JMAP, so replacing a
  draft stores a new one and deletes the old in one request; use the returned
  ID. A reply (`reply_to_email_id`) threads under the original.
- **Sending** submits the message and, once Stalwart accepts it, files it in
  Sent without `$draft`. It cannot be recalled.
- **No invitations.** Saving an event with participants makes Stalwart send
  iTIP messages, so no tool accepts participants, events that have them are
  refused with `PARTICIPANTS_REFUSED` before anything is sent, and every event
  write asks Stalwart not to send scheduling messages. A single occurrence of a
  recurring event is not changed (`INVALID_REQUEST`).
- **Checked before sending.** `pim_destroy_emails` reads every email first and
  refuses the whole batch with `NOT_IN_TRASH` unless each is solely in Trash or
  Junk. `pim_delete_mailbox` never deletes the mail in it.
- **Read-back.** Sieve activation and the vacation reply are confirmed by
  reading them in the same request. Text searches read Stalwart's search index,
  which a new email, event or contact reaches a moment after it is written.

## Errors

Failures return `isError: true` with a text block holding JSON
`{ "code", "message" }`. Raw upstream errors are never returned. Requests
running past 30 seconds return `TIMEOUT` (writes: `WRITE_OUTCOME_UNKNOWN` once
sent).

| Code | Meaning and what to do |
| ----------------------- | --------------------------------------------------------------------------- |
| `AUTH_REQUIRED` | Not signed in, or the sign-in expired or was revoked. Run the login again. |
| `NOT_FOUND` | The item does not exist or this account cannot see it. |
| `INVALID_REQUEST` | Stalwart rejected the input, or an occurrence was targeted. |
| `CURSOR_INVALID` | The cursor does not belong to these inputs. Start without a cursor. |
| `PARTICIPANTS_REFUSED` | The event has participants; saving it would send invitations. |
| `NOT_A_DRAFT` | The email is not a draft in Drafts. Nothing was changed. |
| `NOT_IN_TRASH` | An email to destroy is not solely in Trash or Junk. Nothing was changed. |
| `MAILBOX_NOT_EMPTY` | The mailbox holds mail or child mailboxes. Nothing was changed. |
| `WRITE_REJECTED` | Stalwart refused the change. Nothing was changed. |
| `RATE_LIMITED` | Stalwart rate limited the request. Wait. |
| `UPSTREAM_CHANGED` | Stalwart answered in a shape this server does not support. |
| `UPSTREAM_UNAVAILABLE` | Stalwart or the network failed, or the request was cancelled before sending. |
| `TIMEOUT` | A read took longer than 30 seconds. |
| `WRITE_OUTCOME_UNKNOWN` | A sent write may or may not have applied. Read the target before retrying. |

## Logging

Records are JSONL on stderr with `schema_version: 1`, UTC `timestamp`, `level`
and a fixed `event`. Fields are limited to fixed names, counts, durations, HTTP
statuses, safe codes and JMAP method names. Tokens, device codes, account names,
addresses, IDs, subjects and bodies have no field and are never logged. The
`login` command prints the address, code and account name to the operator's
terminal (or the login unit's journal), never a token.

| Event | Level | Content |
| -------------------- | ---------- | ------------------------------------------------------------ |
| `server.start` | info | enabled write groups, if any |
| `server.stop` | info | `SIGINT`, `SIGTERM` or `transport_closed` |
| `server.fatal` | error | fixed code `PROCESS_FAILURE` |
| `config.invalid` | error | configuration code |
| `http.rejected` | warn | HTTP status |
| `auth.refresh` | info, warn | trigger (`request`, `background`, `unauthorized`), outcome, whether the token rotated, safe code, HTTP status, duration |
| `state.write_failed` | error | `STATE_WRITE_FAILED` |
| `request.end` | info, warn | tool, outcome, safe code, returned count, duration |
| `upstream.write` | debug | JMAP methods of a sent write, whether it was answered, HTTP status |
| `logs.dropped` | warn | records lost to backpressure |

## Verification status

[VERIFICATION.md](VERIFICATION.md) records each run. Every tool has been checked
against a real Stalwart 0.15.5 in the NixOS VM test; the live server has not
been checked yet.
