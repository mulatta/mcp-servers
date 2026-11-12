# Developing the PIM MCP

## Setup

From the repository root:

```sh
nix develop .#pim
cd mcp_servers/pim
bun install --frozen-lockfile
bun run check   # typecheck and Prettier
bun run test    # protocol suite, no server or account
```

`bun run format` formats TypeScript and JSON in this package; `nix fmt` from the
repository root formats Markdown and Nix. After changing dependencies, update
`bun.lock` and regenerate `bun.nix` with the pinned bun2nix
(`nix run github:Mic92/bun2nix/<rev> -- -o bun.nix`, revision from
`flake.lock`). Packaging lives in `nix/pim.nix`, the flakelet module in
`nix/flakelet-pim.nix`.

## Protocol tests

`bun run test` runs `tests/protocol` against a fake Stalwart
(`tests/fixtures/stalwart.ts`) that implements Basic authentication, the JMAP
session and the JMAP API with Stalwart 0.15's answer shapes. They cover
configuration, the JMAP client's error rules (including that a refused
password is not sent again), every tool's requests and answers, the write
groups, and the stdio and HTTP processes with their diagnostics. Every value in
them is synthetic.

## VM test

`nix build .#checks.x86_64-linux.vm-flakelet-pim` boots a NixOS VM with a real
Stalwart 0.15 set up like the production host (PostgreSQL storage, accounts in
a Kanidm 1.11 LDAP directory with the entry UUID as account secret), binding
through a Kanidm application `mail` so that only application passwords sign
in, and the flakelet artifact with every write group. It:

1. provisions two Kanidm people in the mail group, sets their passwords through
   Kanidm's credential update API, creates the application and Stalwart's LDAP
   bind token, and has each person issue application passwords: `pim` and
   `phone` for the account, `laptop` for the second account;
1. restarts the server with the `pim` password and checks that it signs in;
1. runs `tests/vm/driver.ts` over HTTP, which exercises every tool: drafts,
   sending to the second account, replies, flags and tags, mailboxes, trash
   and destroy, Sieve, vacation, calendar and contacts, then removes what it
   made;
1. checks that the second account received the mail and that the journal holds
   no password, token, address or test subject;
1. restarts Stalwart and checks that the server stays signed in;
1. has the person delete the `pim` password and checks that the next call is
   `AUTH_REQUIRED` while `phone` still signs in;
1. issues a new password, restarts the server and checks that it signs in;
1. checks that the Unix password no longer signs in to mail.

Kanidm requires a second factor for people by default; the test lowers the
policy to a password so that it can sign people in without a terminal.

It takes about a minute once Stalwart is built. [UPSTREAM.md](UPSTREAM.md) lists
the packaging workarounds it carries.

## Live checks

The VM test covers what the production directory changes. Live checks remain
for the deployment itself (proxy, public URL, data written by other clients);
they change a real account and need the account owner's approval each time.
They use a dedicated test account, never your own, and a second test account
that receives the run's mail; both must be allowed to use mail on the server.

1. As the test account, issue a mail application password for the run and
   write it to a file.
1. Copy `.env.test.example` to `.env.test` and fill in the server, the test
   account's login name, address and password file, the second account's
   address, and your own login name, which every run refuses.
1. `bun run live:test` confirms the password belongs to the test account, serves
   pim-mcp on a loopback port with a throwaway token and every write group, and
   runs the same driver as the VM test. The run leaves the second account with
   two received messages; everything else it creates it deletes. Delete the
   run's password afterwards.

The driver turns the vacation reply on and off, activates and deletes a Sieve
script of its own, and deactivates Sieve filtering on the way, so run it only on
an account whose filters and auto-reply do not matter. Record results in
[VERIFICATION.md](VERIFICATION.md).
