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

## Live server

Not run yet. It needs the dedicated test accounts described in
[DEVELOPMENT.md](DEVELOPMENT.md#live-checks) and the owner's approval.
