import { Log } from "youtubei.js";
import { acquireCookies } from "../../src/auth/cdp.ts";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { errorResult } from "../../src/errors.ts";

const signal = AbortSignal.timeout(2000);
try {
  const cookie = await acquireCookies(process.env.FIXTURE_CDP!, signal);
  Log.warn("fixture", cookie);
  const session = await YoutubeClient.connect(cookie, signal, (request) =>
    fetch(new Request(process.env.FIXTURE_UPSTREAM!, request)),
  );
  console.log(JSON.stringify({ account_id: session.accountId }));
} catch (error) {
  console.log(JSON.stringify(errorResult(error)));
}
