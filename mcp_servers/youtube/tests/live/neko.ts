import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import type { LiveEnv } from "./env.ts";

type Neko = LiveEnv["neko"];

/**
 * The test browser: a rootless podman Neko holding the test account's
 * Google session. The digest keeps a re-pushed tag from changing the
 * browser under the saved profile; it matches the Neko on citra.
 */
export const image =
  "ghcr.io/m1k1o/neko/chromium:3.2.0@sha256:270face8b8111e639744fb7bcdbbf0deed227900bb89d58b2f8adfc12af8c41e";

const inside = { ui: 8080, chromium: 9222, relay: 9223 };
const profile = "/home/neko/chrome-profile";

// Chromium in this image binds DevTools to loopback whatever
// --remote-debugging-address says, and rootless port forwarding reaches the
// container's own address, not its loopback. The image ships Python but no
// socat, so a byte relay bridges the two.
const relay = `import asyncio
import sys


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        upstream = await asyncio.open_connection("127.0.0.1", int(sys.argv[2]))
    except OSError:
        writer.close()
        return
    await asyncio.gather(pipe(reader, upstream[1]), pipe(upstream[0], writer))


async def main() -> None:
    server = await asyncio.start_server(handle, "0.0.0.0", int(sys.argv[1]))
    async with server:
        await server.serve_forever()


asyncio.run(main())
`;

// A prerendered tab's main frame id differs from its target id, which hangs
// Playwright connectOverCDP (microsoft/playwright#41397).
const chromium = `[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/chromium
  --no-sandbox
  --window-position=0,0
  --display=%(ENV_DISPLAY)s
  --user-data-dir=${profile}
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port=${inside.chromium}
  --no-first-run
  --start-maximized
  --disable-file-system
  --disable-dev-shm-usage
  --disable-features=Prerender2
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/chromium.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=2
redirect_stderr=true

[program:openbox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/openbox.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=2
redirect_stderr=true

[program:cdp-relay]
command=/usr/bin/python3 /etc/neko/cdp-relay.py ${inside.relay} ${inside.chromium}
autorestart=true
priority=900
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/cdp-relay.log
stdout_logfile_maxbytes=1MB
stdout_logfile_backups=1
redirect_stderr=true
`;

const policy = {
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  // Watch history seeding plays videos without a user gesture.
  AutoplayAllowed: true,
  BrowserAddPersonEnabled: false,
  BrowserGuestModeEnabled: false,
  BrowserSignin: 0,
  DefaultNotificationsSetting: 2,
  DefaultPopupsSetting: 2,
  DownloadRestrictions: 3,
  ExtensionInstallBlocklist: ["*"],
  PasswordManagerEnabled: false,
  PromptForDownloadLocation: false,
  SyncDisabled: true,
};

/** Read-only configuration files, by name under `<dataDir>/conf`. */
export function nekoFiles(): Record<string, string> {
  return {
    "chromium.conf": chromium,
    "cdp-relay.py": relay,
    "policies.json": `${JSON.stringify(policy, null, 2)}\n`,
  };
}

const conf = (neko: Neko) => `${neko.dataDir}/conf`;

/** Arguments after `podman` that start the test browser. */
export function runArgs(neko: Neko): string[] {
  const dir = conf(neko);
  const env = {
    NEKO_DESKTOP_SCREEN: "1280x720@30",
    NEKO_MEMBER_PROVIDER: "multiuser",
    // Viewers reach the media port through an SSH tunnel to this loopback.
    NEKO_WEBRTC_ICELITE: "true",
    NEKO_WEBRTC_NAT1TO1: "127.0.0.1",
    NEKO_WEBRTC_TCPMUX: String(neko.mediaPort),
    NEKO_WEBRTC_UDPMUX: String(neko.mediaPort),
  };
  return [
    "run",
    "--detach",
    "--replace",
    "--name",
    neko.name,
    "--hostname",
    "neko",
    // The invoking user becomes the image's neko user (uid 1000), so the
    // profile stays readable and removable without sudo. supervisord must
    // still start as root to drop to neko.
    "--userns=keep-id:uid=1000,gid=1000",
    "--user=0:0",
    "--shm-size=1g",
    "-p",
    `127.0.0.1:${neko.uiPort}:${inside.ui}/tcp`,
    "-p",
    `127.0.0.1:${neko.cdpPort}:${inside.relay}/tcp`,
    "-p",
    `127.0.0.1:${neko.mediaPort}:${neko.mediaPort}/tcp`,
    "-p",
    `127.0.0.1:${neko.mediaPort}:${neko.mediaPort}/udp`,
    "-v",
    `${neko.dataDir}/profile:${profile}:rw`,
    "-v",
    `${dir}/chromium.conf:/etc/neko/supervisord/chromium.conf:ro`,
    "-v",
    `${dir}/cdp-relay.py:/etc/neko/cdp-relay.py:ro`,
    "-v",
    `${dir}/policies.json:/etc/chromium/policies/managed/policies.json:ro`,
    "--env-file",
    `${dir}/neko.env`,
    ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    image,
  ];
}

/** Configured ports another process already holds on loopback. */
export async function busyPorts(neko: Neko): Promise<string[]> {
  const ports = {
    YOUTUBE_LIVE_NEKO_CDP_PORT: neko.cdpPort,
    YOUTUBE_LIVE_NEKO_UI_PORT: neko.uiPort,
    YOUTUBE_LIVE_NEKO_MEDIA_PORT: neko.mediaPort,
  };
  const busy: string[] = [];
  for (const [key, port] of Object.entries(ports)) {
    try {
      Bun.listen({
        hostname: "127.0.0.1",
        port,
        socket: { data() {} },
      }).stop(true);
      // WebRTC media also listens on UDP, where kernel sockets such as a
      // WireGuard listener hold ports a TCP probe cannot see.
      if (port === neko.mediaPort)
        (await Bun.udpSocket({ hostname: "127.0.0.1", port })).close();
    } catch {
      busy.push(key);
    }
  }
  return busy;
}

async function podman(args: string[], quiet = true) {
  const child = Bun.spawn(["podman", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: quiet ? "pipe" : "inherit",
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { code, stdout: stdout.trim() };
}

export async function running(neko: Neko) {
  const { code, stdout } = await podman([
    "inspect",
    "--format",
    "{{.State.Running}}",
    neko.name,
  ]);
  return code === 0 && stdout === "true";
}

function password() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString(
    "hex",
  );
}

export async function up(neko: Neko) {
  if (await running(neko)) return "already running";
  const busy = await busyPorts(neko);
  if (busy.length) throw new Error(`ports in use: ${busy.join(", ")}`);
  const dir = conf(neko);
  await mkdir(`${neko.dataDir}/profile`, { recursive: true, mode: 0o700 });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(neko.dataDir, 0o700);
  for (const [name, content] of Object.entries(nekoFiles()))
    await writeFile(`${dir}/${name}`, content, { mode: 0o644 });
  const secrets = Bun.file(`${dir}/neko.env`);
  if (!(await secrets.exists()))
    await writeFile(
      `${dir}/neko.env`,
      `NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${password()}\nNEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${password()}\n`,
      { mode: 0o600 },
    );
  // The previous container is gone, so these locks name dead processes.
  for (const lock of ["SingletonCookie", "SingletonLock", "SingletonSocket"])
    await rm(`${neko.dataDir}/profile/${lock}`, { force: true });
  const { code } = await podman(runArgs(neko), false);
  if (code !== 0) throw new Error(`podman run exited with ${code}`);
  return "started";
}

export async function down(neko: Neko, purge: boolean) {
  await podman(["rm", "--force", "--time", "10", neko.name]);
  if (purge) await rm(neko.dataDir, { recursive: true, force: true });
}

/** Chromium's version string once DevTools answers, or "" on timeout. */
export async function devtools(cdpUrl: string, seconds = 0) {
  const deadline = Date.now() + seconds * 1000;
  do {
    try {
      const response = await fetch(new URL("/json/version", cdpUrl), {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok)
        return ((await response.json()) as { Browser?: string }).Browser ?? "";
    } catch {
      // Not up yet.
    }
    if (Date.now() < deadline) await Bun.sleep(1000);
  } while (Date.now() < deadline);
  return "";
}
