import { SafeError } from "./errors.ts";

export type LogLevel = "error" | "warn" | "info" | "debug";

export function readLogLevel(
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  const level = env.YOUTUBE_LOG_LEVEL ?? "info";
  if (
    level === "error" ||
    level === "warn" ||
    level === "info" ||
    level === "debug"
  )
    return level;
  throw new Error("Invalid log level.");
}

export function readConfig(
  env: Record<string, string | undefined> = process.env,
) {
  try {
    const url = new URL(env.YOUTUBE_CDP_URL ?? "http://127.0.0.1:9222");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error();
    return { cdpUrl: url.href };
  } catch {
    throw new SafeError("BROWSER_UNAVAILABLE");
  }
}

export type ConfigCode = "INVALID_TRANSPORT" | "INVALID_HTTP_CONFIG";

export class ConfigError extends Error {
  constructor(readonly code: ConfigCode) {
    super("Invalid configuration.");
    this.name = "ConfigError";
  }
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
export function readTransport(
  env: Record<string, string | undefined> = process.env,
): TransportConfig {
  const kind = env.YOUTUBE_TRANSPORT ?? "stdio";
  if (kind === "stdio") return { kind };
  if (kind !== "http") throw new ConfigError("INVALID_TRANSPORT");
  const port = env.YOUTUBE_HTTP_PORT ?? "";
  const tokenFile = env.YOUTUBE_HTTP_TOKEN_FILE ?? "";
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535 || !tokenFile)
    throw new ConfigError("INVALID_HTTP_CONFIG");
  return {
    kind,
    hostname: env.YOUTUBE_HTTP_HOST || "127.0.0.1",
    port: Number(port),
    tokenFile,
    allowedHosts: (env.YOUTUBE_HTTP_ALLOWED_HOSTS || "localhost,127.0.0.1")
      .split(",")
      .map((host) => host.trim()),
  };
}
