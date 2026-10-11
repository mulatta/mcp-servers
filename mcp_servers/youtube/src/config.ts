import { SafeError } from "./errors.ts";

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
