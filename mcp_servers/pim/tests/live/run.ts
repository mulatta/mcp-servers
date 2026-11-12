// Live checks against the real Stalwart with a dedicated test account and a
// password issued for this run. Confirms the signed-in account is the test
// account and not the personal one, serves pim-mcp over loopback HTTP with
// every write group, and runs the end-to-end driver against it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Password } from "../../src/auth/password.ts";
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

const account = required("PIM_LIVE_ACCOUNT");
const personal = required("PIM_LIVE_PERSONAL_ACCOUNT");
if (account === personal) {
  console.error("PIM_LIVE_ACCOUNT must differ from PIM_LIVE_PERSONAL_ACCOUNT.");
  process.exit(2);
}
const server = readServer({
  PIM_SERVER_URL: required("PIM_LIVE_SERVER_URL"),
  PIM_USERNAME: account,
  PIM_PASSWORD_FILE: required("PIM_LIVE_PASSWORD_FILE"),
});
const password = (await readFile(server.passwordFile, "utf8")).trim();
const jmap = new Jmap(server, new Password(server.username, password));

// The session names the account the password belongs to.
const name = await jmap.username(AbortSignal.timeout(30_000));
if (name === personal || name !== account) {
  console.error("The password is not the test account's; nothing was changed.");
  process.exit(3);
}

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
