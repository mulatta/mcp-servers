import { acquireCookies } from "./auth/cdp.ts";
import { SessionProvider } from "./auth/session.ts";
import { readConfig } from "./config.ts";
import { Paginator } from "./pagination.ts";
import type { Reader } from "./server.ts";
import { YoutubeClient, type Network } from "./youtube/client.ts";

export function createReader(
  options: { cdpUrl?: string; network?: Network } = {},
): Reader {
  const sessions = new SessionProvider(async (signal) => {
    const cookie = await acquireCookies(
      options.cdpUrl ?? readConfig().cdpUrl,
      signal,
    );
    return YoutubeClient.connect(cookie, signal, options.network);
  });
  const pages = new Paginator(sessions);
  return (name, input, signal) => pages.read(name, input, signal);
}
