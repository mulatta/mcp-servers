/**
 * Settings shared by the live tests and the test-browser setup, read from
 * the git-ignored .env.test (see .env.test.example). Errors name the
 * variable, never its value, because the values identify accounts.
 */
export type LiveEnv = {
  neko: {
    name: string;
    cdpPort: number;
    uiPort: number;
    mediaPort: number;
    dataDir: string;
  };
  cdpUrl: string;
  accountId: string;
  personalAccountId: string;
  reads: boolean;
  writes: boolean;
};

type Env = Record<string, string | undefined>;

const channel = /^UC[A-Za-z0-9_-]{22}$/;

function port(env: Env, key: string, fallback: number) {
  const raw = env[key] || String(fallback);
  const value = Number(raw);
  // Unprivileged ports only: the test browser runs as a rootless container.
  if (!/^\d+$/.test(raw) || value < 1024 || value > 65535)
    throw new Error(`${key} must be a port from 1024 to 65535`);
  return value;
}

function account(env: Env, key: string) {
  const value = env[key] ?? "";
  if (value && !channel.test(value))
    throw new Error(
      `${key} must be a channel ID (UC followed by 22 characters)`,
    );
  return value;
}

export function liveEnv(env: Env): LiveEnv {
  const name = env.YOUTUBE_LIVE_NEKO_NAME || "neko-yt-test";
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name))
    throw new Error(
      "YOUTUBE_LIVE_NEKO_NAME must be lowercase letters, digits, '.', '_' or '-'",
    );
  const ports = {
    YOUTUBE_LIVE_NEKO_CDP_PORT: port(env, "YOUTUBE_LIVE_NEKO_CDP_PORT", 9224),
    YOUTUBE_LIVE_NEKO_UI_PORT: port(env, "YOUTUBE_LIVE_NEKO_UI_PORT", 8083),
    YOUTUBE_LIVE_NEKO_MEDIA_PORT: port(
      env,
      "YOUTUBE_LIVE_NEKO_MEDIA_PORT",
      59224,
    ),
  };
  const keys = Object.keys(ports) as (keyof typeof ports)[];
  for (const [index, a] of keys.entries())
    for (const b of keys.slice(index + 1))
      if (ports[a] === ports[b]) throw new Error(`${a} and ${b} share a port`);

  let dataDir = env.YOUTUBE_LIVE_NEKO_DATA_DIR;
  if (!dataDir) {
    const data =
      env.XDG_DATA_HOME || (env.HOME ? `${env.HOME}/.local/share` : "");
    if (!data)
      throw new Error(
        "set HOME, XDG_DATA_HOME or YOUTUBE_LIVE_NEKO_DATA_DIR for the test browser profile",
      );
    dataDir = `${data}/youtube-mcp/live-neko`;
  }

  const accountId = account(env, "YOUTUBE_LIVE_ACCOUNT_ID");
  const personalAccountId = account(env, "YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID");
  if (accountId && accountId === personalAccountId)
    throw new Error(
      "YOUTUBE_LIVE_ACCOUNT_ID equals YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID; live writes must not touch the personal account",
    );

  const cdpPort = ports.YOUTUBE_LIVE_NEKO_CDP_PORT;
  const cdpUrl = env.YOUTUBE_LIVE_CDP_URL || `http://127.0.0.1:${cdpPort}`;
  const reads = env.YOUTUBE_LIVE === "1";
  const writes = reads && env.YOUTUBE_LIVE_WRITES === "1";
  // Writes name both accounts so a run can tell the test account from the
  // personal one even when the browser was signed into the wrong one.
  if (writes && !accountId)
    throw new Error(
      "YOUTUBE_LIVE_WRITES=1 needs YOUTUBE_LIVE_ACCOUNT_ID, the channel ID of the test account",
    );
  if (writes && !personalAccountId)
    throw new Error(
      "YOUTUBE_LIVE_WRITES=1 needs YOUTUBE_LIVE_PERSONAL_ACCOUNT_ID, the channel ID live writes must refuse",
    );

  return {
    neko: {
      name,
      cdpPort,
      uiPort: ports.YOUTUBE_LIVE_NEKO_UI_PORT,
      mediaPort: ports.YOUTUBE_LIVE_NEKO_MEDIA_PORT,
      dataDir,
    },
    cdpUrl,
    accountId,
    personalAccountId,
    reads,
    writes,
  };
}
