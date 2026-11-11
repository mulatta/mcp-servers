// Live checks against the real Stalwart with a dedicated test account.
// `login` signs that account in; `test` confirms the signed-in account is
// the test account and not the personal one, serves pim-mcp over loopback
// HTTP with every write group, and runs the end-to-end driver against it.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { login } from "../../src/auth/login.ts";
import { Credentials, TokenStore } from "../../src/auth/tokens.ts";
import { readServer, writeGroups } from "../../src/config.ts";
import { startHttp } from "../../src/http.ts";
import { Jmap } from "../../src/jmap/client.ts";

function required(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} in .env.test (see .env.test.example).`);
    process.exit(2);
  }
  return value;
}

const stateHome =
  process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local/state");
const server = readServer({
  PIM_SERVER_URL: required("PIM_LIVE_SERVER_URL"),
  PIM_CLIENT_ID: process.env.PIM_LIVE_CLIENT_ID,
  PIM_STATE_DIR:
    process.env.PIM_LIVE_STATE_DIR || join(stateHome, "pim-mcp", "live"),
});
const account = required("PIM_LIVE_ACCOUNT");
const personal = required("PIM_LIVE_PERSONAL_ACCOUNT");
if (account === personal) {
  console.error("PIM_LIVE_ACCOUNT must differ from PIM_LIVE_PERSONAL_ACCOUNT.");
  process.exit(2);
}
const store = new TokenStore(server.stateDir);

/** Refuses to continue unless the stored sign-in is the test account. */
async function signedInAccount(jmap: Jmap) {
  const name = await jmap.username(AbortSignal.timeout(30_000));
  if (name === personal || name !== account) {
    console.error(
      "The stored sign-in is not the test account; nothing was changed.",
    );
    process.exit(3);
  }
}

const command = process.argv[2];
if (command === "login") {
  await login(server, store, { print: (line) => console.error(line) });
  await signedInAccount(new Jmap(server, new Credentials(server, store)));
  process.exit(0);
}
if (command !== "test") {
  console.error("Usage: bun run live:login | bun run live:test");
  process.exit(2);
}

const jmap = new Jmap(server, new Credentials(server, store));
await signedInAccount(jmap);
const scratch = await mkdtemp(join(tmpdir(), "pim-live-"));
const token = crypto.randomUUID() + crypto.randomUUID();
await writeFile(join(scratch, "token"), token, { mode: 0o600 });
const http = await startHttp(jmap, {
  hostname: "127.0.0.1",
  port: 0,
  token,
  allowedHosts: ["127.0.0.1"],
  writes: new Set(writeGroups),
  timeoutMs: 60_000,
});
try {
  const driver = Bun.spawn(
    [process.execPath, new URL("../vm/driver.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PIM_VM_URL: http.url.href,
        PIM_VM_TOKEN_FILE: join(scratch, "token"),
        PIM_VM_ADDRESS: required("PIM_LIVE_ADDRESS"),
        PIM_VM_FRIEND: required("PIM_LIVE_FRIEND"),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  process.exitCode = await driver.exited;
} finally {
  await http.stop();
  await rm(scratch, { recursive: true, force: true });
}
