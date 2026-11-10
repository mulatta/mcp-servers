import { acquireCookies } from "./auth/cdp.ts";
import { SessionProvider } from "./auth/session.ts";
import { readConfig } from "./config.ts";
import { Paginator } from "./pagination.ts";
import type { Reader } from "./server.ts";
import { createWriter, type Writer } from "./writer.ts";
import { YoutubeClient, type Network } from "./youtube/client.ts";

// Reads and writes share one session, so both use the same pinned account.
export function createBackend(
  options: { cdpUrl?: string; network?: Network } = {},
): { reader: Reader; writer: Writer } {
  const sessions = new SessionProvider(async (signal) => {
    const cookie = await acquireCookies(
      options.cdpUrl ?? readConfig().cdpUrl,
      signal,
    );
    return YoutubeClient.connect(cookie, signal, options.network);
  });
  const pages = new Paginator(sessions);
  return {
    reader: (name, input, signal) =>
      name === "youtube_get_playlist_details"
        ? sessions.run(signal, false, async (snapshot) => ({
            account_id: snapshot.accountId,
            playlist_id: input.playlist_id,
            ...(await snapshot.value.details(input.playlist_id!, signal)),
          }))
        : pages.read(name, input, signal),
    writer: createWriter(sessions),
  };
}

export function createReader(
  options: { cdpUrl?: string; network?: Network } = {},
): Reader {
  return createBackend(options).reader;
}
