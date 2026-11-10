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
