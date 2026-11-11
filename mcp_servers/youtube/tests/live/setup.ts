import { chmod, writeFile } from "node:fs/promises";
import { liveEnv } from "./env.ts";
import { accountUpdates, setEnv } from "./envfile.ts";
import { connect } from "./live.ts";
import { type AccountState, accountProbe, waitForAccount } from "./login.ts";
import { devtools, down, running, up } from "./neko.ts";

/**
 * Manages the test browser for live tests. Output stays to states, counts
 * and local paths: never account IDs, titles or secrets.
 */
const usage = `usage: bun run live:setup [--timeout <minutes>] [--keep]
       bun run live:setup <command>

Without a command: start the test browser, wait for you to sign in to the
test account (10 minutes by default), record it in .env.test, and stop the
browser again. --keep leaves it running.

  up               start the test browser (pulls the pinned image once)
  status           show whether the browser and DevTools are up
  check [--write]  confirm the test account; --write records it in .env.test
  test [--writes] [--keep] [-- <bun test args>]
                   run tests/live against the test browser, starting and
                   stopping it around the run; --writes includes write tests,
                   which clear and rebuild the test account
  down [--purge]   stop the browser; --purge also deletes its profile`;

const env = liveEnv(process.env);
const { neko } = env;
// Always the container's own port: YOUTUBE_LIVE_CDP_URL may name another
// browser, which setup must never touch.
const cdpUrl = `http://127.0.0.1:${neko.cdpPort}`;
const [command, ...rest] = process.argv.slice(2);

const envFile = new URL("../../.env.test", import.meta.url);
const example = new URL("../../.env.test.example", import.meta.url);

/** Records an account read from the test browser; false when refused. */
async function record(found: string, write: boolean) {
  const file = Bun.file(envFile);
  const text = (await file.exists())
    ? await file.text()
    : await Bun.file(example).text();
  const plan = accountUpdates(text, found, env.personalAccountId, cdpUrl);
  if ("refuse" in plan) {
    console.log(`account: refused, ${plan.refuse}`);
    return false;
  }
  console.log("account: signed in with a channel, not the personal account");
  const changes = Object.entries(plan.updates).map(([key, value]) =>
    value === null ? `remove ${key}` : `set ${key}`,
  );
  if (!changes.length) {
    console.log(".env.test: already records this account");
    return true;
  }
  for (const change of changes) console.log(`.env.test: ${change}`);
  if (!write) {
    console.log("rerun with --write to apply");
    return false;
  }
  await writeFile(envFile, setEnv(text, plan.updates));
  // The file names both accounts; keep it private even if it predates setup.
  await chmod(envFile, 0o600);
  console.log(".env.test: written");
  return true;
}

async function check(write: boolean) {
  if (!(await running(neko)) || !(await devtools(cdpUrl)))
    throw new Error("the test browser is not up; run live:setup up");
  const state = await accountProbe(cdpUrl, "", connect)();
  if (state.state !== "ready") {
    console.log(`account: ${describe(state)}`);
    return false;
  }
  return record(state.accountId, write);
}

function describe(state: AccountState) {
  switch (state.state) {
    case "signed-out":
      return "not signed in; sign in to the test account on youtube.com";
    case "no-channel":
      return "signed in, but the account has no YouTube channel; create one";
    case "personal":
      return "this is YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID; sign out and sign in to the test account";
    case "error":
      return `the account read failed with ${state.code}`;
    case "ready":
      return "signed in with a channel";
  }
}

async function start() {
  console.log(`${neko.name}: ${await up(neko)}`);
  const browser = await devtools(cdpUrl, 90);
  if (!browser)
    throw new Error(
      `DevTools did not answer within 90 s; see podman logs ${neko.name}`,
    );
  console.log(`devtools ${cdpUrl}: ${browser}`);
}

const instructions = () => `
Open http://127.0.0.1:${neko.uiPort} and join with any name and the admin
password, NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD in

  ${neko.dataDir}/conf/neko.env

Take control and sign in to the test account on youtube.com. That account
needs a YouTube channel.

Video arrives over WebRTC from 127.0.0.1, which browsers refuse by default:
if the screen stays blank after joining, set media.peerconnection.ice.loopback
to true in Firefox's about:config, or start Chromium with
--allow-loopback-in-peer-connection.

Every port binds to 127.0.0.1. To view from another machine, forward TCP
ports ${neko.uiPort} (UI) and ${neko.mediaPort} (video) to the same ports there.
`;

/** Runs `work` with the browser up, stopping it after if this started it. */
async function withBrowser<T>(work: () => Promise<T>, keep: boolean) {
  const started = !(await running(neko));
  const stop = async () => {
    if (!started || keep) return;
    await down(neko, false);
    console.log(`${neko.name}: stopped`);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void stop().finally(() => process.exit(130));
    });
  try {
    if (started) await start();
    return await work();
  } finally {
    await stop();
  }
}

async function runTests(writes: boolean, extra: string[]) {
  const state = await accountProbe(cdpUrl, env.personalAccountId, connect)();
  if (state.state !== "ready" || state.accountId !== env.accountId) {
    console.log(
      state.state === "ready"
        ? "account: not YOUTUBE_LIVE_ACCOUNT_ID; run live:setup"
        : `account: ${describe(state)}`,
    );
    return 1;
  }
  // Bun ORs path filters, so a given filter replaces the whole directory.
  const paths = extra.some((arg) => !arg.startsWith("-")) ? [] : ["tests/live"];
  const child = Bun.spawn([process.execPath, "test", ...paths, ...extra], {
    cwd: new URL("../..", import.meta.url).pathname,
    env: {
      ...process.env,
      YOUTUBE_LIVE: "1",
      YOUTUBE_LIVE_WRITES: writes ? "1" : "",
      // The tests drive this browser, whatever .env.test names.
      YOUTUBE_LIVE_CDP_URL: cdpUrl,
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return child.exited;
}

async function guided(minutes: number, keep: boolean) {
  if (!env.personalAccountId)
    throw new Error(
      "set YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID in .env.test first; setup refuses that account",
    );
  const stop = async () => {
    if (keep) return;
    await down(neko, false);
    console.log(`${neko.name}: stopped`);
  };
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      interrupted = true;
      console.log("interrupted");
      void stop().finally(() => process.exit(130));
    });
  try {
    await start();
    let guide = true;
    const found = await waitForAccount(
      accountProbe(cdpUrl, env.personalAccountId, connect),
      {
        timeoutMs: minutes * 60_000,
        intervalMs: 5000,
        onState: (state) => {
          // A poll racing the shutdown fails; that is not news.
          if (state.state === "ready" || interrupted) return;
          // Only when there is something to do: a signed-in profile skips it.
          if (guide)
            console.log(`${instructions()}\nwaiting up to ${minutes} min`);
          guide = false;
          console.log(`waiting: ${describe(state)}`);
        },
      },
    );
    if (!found) {
      console.log(`no test account within ${minutes} min`);
      return false;
    }
    return await record(found, true);
  } finally {
    await stop();
  }
}

async function status() {
  const up = await running(neko);
  const browser = up ? await devtools(cdpUrl) : "";
  console.log(`container ${neko.name}: ${up ? "running" : "stopped"}`);
  console.log(`devtools ${cdpUrl}: ${browser || "not answering"}`);
  return up && browser !== "";
}

const minutes = (() => {
  const args = process.argv.slice(2);
  const index = args.indexOf("--timeout");
  if (index < 0) return 10;
  const value = Number(args[index + 1]);
  if (!(value > 0)) throw new Error("--timeout needs a number of minutes");
  return value;
})();

switch (command) {
  case undefined:
  case "--timeout":
  case "--keep":
    process.exitCode = (await guided(minutes, process.argv.includes("--keep")))
      ? 0
      : 1;
    break;
  case "up":
    await start();
    break;
  case "check":
    process.exitCode = (await check(rest.includes("--write"))) ? 0 : 1;
    break;
  case "test": {
    const split = rest.indexOf("--");
    const extra = split < 0 ? [] : rest.slice(split + 1);
    const flags = split < 0 ? rest : rest.slice(0, split);
    process.exitCode = await withBrowser(
      () => runTests(flags.includes("--writes"), extra),
      flags.includes("--keep"),
    );
    break;
  }
  case "status":
    process.exitCode = (await status()) ? 0 : 1;
    break;
  case "down":
    await down(neko, rest.includes("--purge"));
    console.log(
      `${neko.name}: removed${rest.includes("--purge") ? " with its profile" : ""}`,
    );
    break;
  default:
    console.error(usage);
    process.exitCode = 2;
}
