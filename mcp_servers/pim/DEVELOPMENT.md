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
(`tests/fixtures/stalwart.ts`) that implements the OAuth device and token
endpoints, the JMAP session and the JMAP API with Stalwart 0.15's answer
shapes. They cover configuration, the token file (including saves interrupted
before and after the rename), shared refreshes, the device login, the JMAP
client's retry and error rules, every tool's requests and answers, the write
groups, and the stdio and HTTP processes with their diagnostics. Every value in
them is synthetic.

## VM test

`nix build .#checks.x86_64-linux.vm-flakelet-pim` boots a NixOS VM with a real
Stalwart 0.15 set up like the production host (PostgreSQL storage, registered
OAuth clients only) and the flakelet artifact with every write group. It:

1. creates two accounts and the `pim-mcp` client through the management API;
1. checks that the server answers `AUTH_REQUIRED` before any login;
1. starts `pim-mcp-login.service`, reads the code from its journal, approves it
   as the account, and checks that the running server picks up the token and
   that `token.json` is mode 0600;
1. runs `tests/vm/driver.ts` over HTTP, which exercises every tool: drafts,
   sending to the second account, replies, flags and tags, mailboxes, trash
   and destroy, Sieve, vacation, calendar and contacts, then removes what it
   made;
1. checks that the second account received the mail, that the journal holds no
   token, address or test subject, and that a revoked refresh token yields
   `AUTH_REQUIRED`.

It takes about a minute once Stalwart is built. [UPSTREAM.md](UPSTREAM.md) lists
the packaging workarounds it carries.

## Live checks

Live checks change a real account and need the account owner's approval each
time. They use a dedicated test account, never your own, and a second test
account that receives the run's mail; both must be allowed to use mail on the
server.

1. Copy `.env.test.example` to `.env.test` and fill in the server, the test
   account's login name and address, the second account's address, and your
   own login name, which login and every run refuse.
1. `bun run live:login` performs the device login for the test account into
   `$XDG_STATE_HOME/pim-mcp/live` and stops if the approved account is not the
   test account.
1. `bun run live:test` confirms the stored sign-in is the test account, serves
   pim-mcp on a loopback port with a throwaway token and every write group, and
   runs the same driver as the VM test. The run leaves the second account with
   two received messages; everything else it creates it deletes.

The driver turns the vacation reply on and off, activates and deletes a Sieve
script of its own, and deactivates Sieve filtering on the way, so run it only on
an account whose filters and auto-reply do not matter. Record results in
[VERIFICATION.md](VERIFICATION.md).
