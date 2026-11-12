# Verification record

## 2026-11-11: protocol suite

`bun run test`: 100 tests in 12 files pass, also inside the Nix package build.

## 2026-11-11: VM test against Stalwart 0.15.5

`nix build .#checks.x86_64-linux.vm-flakelet-pim` on x86_64-linux passes: device
login through the login unit with registered clients required, all 39 tools
over HTTP, delivery to a second account, a clean journal, and `AUTH_REQUIRED`
after revocation.

Found and fixed on the way (see [UPSTREAM.md](UPSTREAM.md)): plain events
refused as occurrences, the 365-day expansion limit, `filter: null`, contact
name search, Sieve validation of an uploaded blob, and identities for
addresses without a public suffix.

## 2026-11-13: VM test with Kanidm application passwords

The same check passes with accounts in Kanidm 1.11 over LDAP, binding through a
Kanidm application: the server signs in with an application password issued
for it, all 39 tools pass, it stays signed in across a Stalwart restart, the
next call after the person deletes that password is `AUTH_REQUIRED` while the
account's other application password still works, and the Unix password no
longer signs in to mail.

## 2026-11-12: live read check

With the owner's approval, the owner's account on the production server was
signed in by OAuth device login, which this server used then, and every read
tool was called with no write group
enabled; only outcomes and counts were recorded. All 14 read tools answer.
`pim_get_vacation` failed with `UPSTREAM_CHANGED` on this account, which had
never set a vacation reply (see [UPSTREAM.md](UPSTREAM.md)); fixed and
re-checked.

## Live server writes

Not run yet. They need the dedicated test accounts described in
[DEVELOPMENT.md](DEVELOPMENT.md#live-checks) and the owner's approval.
