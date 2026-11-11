export type LogLevel = "error" | "warn" | "info" | "debug";
type Env = Record<string, string | undefined>;

export function readLogLevel(env: Env = process.env): LogLevel {
  const level = env.PIM_LOG_LEVEL ?? "info";
  if (
    level === "error" ||
    level === "warn" ||
    level === "info" ||
    level === "debug"
  )
    return level;
  throw new Error("Invalid log level.");
}

export type ConfigCode =
  | "INVALID_SERVER"
  | "INVALID_TRANSPORT"
  | "INVALID_HTTP_CONFIG"
  | "INVALID_WRITES";

export class ConfigError extends Error {
  constructor(readonly code: ConfigCode) {
    super("Invalid configuration.");
    this.name = "ConfigError";
  }
}

export interface ServerConfig {
  /** Origin of the Stalwart HTTP listener, without a trailing slash. */
  origin: string;
  clientId: string;
  /** Directory holding the rotating OAuth token. */
  stateDir: string;
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function readServer(env: Env = process.env): ServerConfig {
  let url: URL;
  try {
    url = new URL(env.PIM_SERVER_URL ?? "");
  } catch {
    throw new ConfigError("INVALID_SERVER");
  }
  // Bearer tokens must not cross the network in clear text; plain HTTP is
  // only for a listener on the same host, such as the VM test.
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopback.has(url.hostname));
  if (
    !secure ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new ConfigError("INVALID_SERVER");
  const clientId = env.PIM_CLIENT_ID || "pim-mcp";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(clientId))
    throw new ConfigError("INVALID_SERVER");
  return { origin: url.origin, clientId, stateDir: stateDir(env) };
}

function stateDir(env: Env) {
  if (env.PIM_STATE_DIR) return env.PIM_STATE_DIR;
  // systemd lists every StateDirectory= entry, separated by colons.
  const systemd = env.STATE_DIRECTORY?.split(":")[0];
  if (systemd) return systemd;
  if (env.XDG_STATE_HOME) return `${env.XDG_STATE_HOME}/pim-mcp`;
  if (env.HOME) return `${env.HOME}/.local/state/pim-mcp`;
  throw new ConfigError("INVALID_SERVER");
}

export type TransportConfig =
  | { kind: "stdio" }
  | {
      kind: "http";
      hostname: string;
      port: number;
      tokenFile: string;
      allowedHosts: string[];
    };

// Only the shape is checked here; startHttp owns token and host validity.
export function readTransport(env: Env = process.env): TransportConfig {
  const kind = env.PIM_TRANSPORT ?? "stdio";
  if (kind === "stdio") return { kind };
  if (kind !== "http") throw new ConfigError("INVALID_TRANSPORT");
  const port = env.PIM_HTTP_PORT ?? "";
  const tokenFile = env.PIM_HTTP_TOKEN_FILE ?? "";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || !tokenFile)
    throw new ConfigError("INVALID_HTTP_CONFIG");
  return {
    kind,
    hostname: env.PIM_HTTP_HOST || "127.0.0.1",
    port: Number(port),
    tokenFile,
    allowedHosts: (env.PIM_HTTP_ALLOWED_HOSTS || "localhost,127.0.0.1")
      .split(",")
      .map((host) => host.trim()),
  };
}

export const writeGroups = [
  "flag",
  "organize",
  "delete",
  "draft",
  "send",
  "sieve",
  "vacation",
  "calendar",
  "contact",
] as const;
export type WriteGroup = (typeof writeGroups)[number];

// Unset or empty keeps the server read-only. Any unknown token refuses to start,
// so a typo can neither enable nor silently drop a group.
export function readWrites(env: Env = process.env): ReadonlySet<WriteGroup> {
  const raw = env.PIM_WRITES ?? "";
  if (raw === "") return new Set();
  const tokens = raw.split(",").map((token) => token.trim());
  if (tokens.length === 1 && tokens[0] === "all") return new Set(writeGroups);
  const groups = new Set<WriteGroup>();
  for (const token of tokens) {
    if (!(writeGroups as readonly string[]).includes(token))
      throw new ConfigError("INVALID_WRITES");
    groups.add(token as WriteGroup);
  }
  return groups;
}
