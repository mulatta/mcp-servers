import { describe, expect, test } from "bun:test";
import { liveEnv } from "../live/env.ts";
import { busyPorts, image, nekoFiles, runArgs } from "../live/neko.ts";

const { neko } = liveEnv({
  HOME: "/home/tester",
  YOUTUBE_LIVE_NEKO_CDP_PORT: "9300",
  YOUTUBE_LIVE_NEKO_UI_PORT: "8300",
  YOUTUBE_LIVE_NEKO_MEDIA_PORT: "59300",
});
const data = "/home/tester/.local/share/youtube-mcp/live-neko";

function values(args: string[], flag: string) {
  return args.flatMap((arg, index) =>
    arg === flag ? [args[index + 1] as string] : [],
  );
}

describe("test browser container", () => {
  test("publishes every port on loopback only", () => {
    const published = values(runArgs(neko), "-p");
    expect(published.sort()).toEqual(
      [
        "127.0.0.1:59300:59300/tcp",
        "127.0.0.1:59300:59300/udp",
        "127.0.0.1:8300:8080/tcp",
        "127.0.0.1:9300:9223/tcp",
      ].sort(),
    );
  });

  test("runs the pinned image under the configured name", () => {
    const args = runArgs(neko);
    expect(image).toMatch(
      /^ghcr\.io\/m1k1o\/neko\/chromium:[\d.]+@sha256:[0-9a-f]{64}$/,
    );
    expect(args.at(-1)).toBe(image);
    expect(values(args, "--name")).toEqual([neko.name]);
  });

  test("keeps the profile writable and owned by the invoking user", () => {
    const args = runArgs(neko);
    // The invoking user becomes the image's neko user (uid 1000), while
    // supervisord still starts as root to drop to it.
    expect(args).toContain("--userns=keep-id:uid=1000,gid=1000");
    expect(args).toContain("--user=0:0");
    const volumes = values(args, "-v");
    expect(volumes).toContain(`${data}/profile:/home/neko/chrome-profile:rw`);
    for (const volume of volumes.filter((v) => !v.includes("chrome-profile")))
      expect(volume.endsWith(":ro")).toBe(true);
    expect(values(args, "--env-file")).toEqual([`${data}/conf/neko.env`]);
  });

  test("Neko advertises the media port it listens on, on loopback", () => {
    const env = values(runArgs(neko), "-e");
    expect(env).toContain("NEKO_WEBRTC_TCPMUX=59300");
    expect(env).toContain("NEKO_WEBRTC_UDPMUX=59300");
    expect(env).toContain("NEKO_WEBRTC_NAT1TO1=127.0.0.1");
    expect(env).toContain("NEKO_MEMBER_PROVIDER=multiuser");
  });

  test("relays the published CDP port to Chromium's loopback port", () => {
    const files = nekoFiles();
    const chromium = files["chromium.conf"] ?? "";
    expect(chromium).toContain("--remote-debugging-port=9222");
    expect(chromium).toContain("--user-data-dir=/home/neko/chrome-profile");
    expect(chromium).toMatch(
      /\[program:cdp-relay\][^[]*cdp-relay\.py 9223 9222/,
    );
    expect(files["cdp-relay.py"]).toContain("asyncio");
    const policy = JSON.parse(files["policies.json"] ?? "{}");
    // Watch history seeding plays videos without a user gesture.
    expect(policy.AutoplayAllowed).toBe(true);
    expect(policy.ExtensionInstallBlocklist).toEqual(["*"]);
  });
});

// Ports free over TCP and UDP right now, so the test does not depend on
// what else this host runs (such as a test browser on the defaults).
async function freePorts(count: number) {
  const ports: number[] = [];
  while (ports.length < count) {
    const tcp = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = tcp.port;
    tcp.stop(true);
    try {
      (await Bun.udpSocket({ hostname: "127.0.0.1", port })).close();
      if (!ports.includes(port)) ports.push(port);
    } catch {
      // Held over UDP; try another.
    }
  }
  return ports;
}

async function nekoOn(held: { key: string; port: number }) {
  const [cdp, ui, media] = await freePorts(3);
  return liveEnv({
    HOME: "/home/tester",
    YOUTUBE_LIVE_NEKO_CDP_PORT: String(cdp),
    YOUTUBE_LIVE_NEKO_UI_PORT: String(ui),
    YOUTUBE_LIVE_NEKO_MEDIA_PORT: String(media),
    [held.key]: String(held.port),
  }).neko;
}

describe("port conflicts", () => {
  test("names every configured port another process holds", async () => {
    const held = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const neko = await nekoOn({
        key: "YOUTUBE_LIVE_NEKO_UI_PORT",
        port: held.port,
      });
      expect(await busyPorts(neko)).toEqual(["YOUTUBE_LIVE_NEKO_UI_PORT"]);
    } finally {
      held.stop(true);
    }
  });

  test("checks the media port over UDP too", async () => {
    // WebRTC media also listens on UDP, where kernel sockets such as a
    // WireGuard listener hold ports that a TCP probe cannot see.
    const held = await Bun.udpSocket({ hostname: "127.0.0.1" });
    try {
      const neko = await nekoOn({
        key: "YOUTUBE_LIVE_NEKO_MEDIA_PORT",
        port: held.port,
      });
      expect(await busyPorts(neko)).toEqual(["YOUTUBE_LIVE_NEKO_MEDIA_PORT"]);
    } finally {
      held.close();
    }
  });
});
