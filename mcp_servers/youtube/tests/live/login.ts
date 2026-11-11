import type { Live } from "./live.ts";

export type AccountState =
  | { state: "signed-out" }
  | { state: "no-channel" }
  | { state: "personal" }
  | { state: "error"; code: string }
  | { state: "ready"; accountId: string };

/**
 * Polls until the test browser holds a usable test account or the timeout
 * passes, reporting each state once as it first appears.
 */
export async function waitForAccount(
  probe: () => Promise<AccountState>,
  options: {
    timeoutMs: number;
    intervalMs: number;
    onState: (state: AccountState) => void;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
  },
): Promise<string | undefined> {
  const { now = Date.now, sleep = Bun.sleep } = options;
  const deadline = now() + options.timeoutMs;
  let last = "";
  for (;;) {
    let state: AccountState;
    try {
      state = await probe();
    } catch {
      // The message may carry upstream text; only a fixed code is shown.
      state = { state: "error", code: "PROBE_FAILED" };
    }
    const key = state.state === "error" ? `error:${state.code}` : state.state;
    if (key !== last) options.onState(state);
    last = key;
    if (state.state === "ready") return state.accountId;
    await sleep(options.intervalMs);
    if (now() >= deadline) return undefined;
  }
}

/** Whether the browser holds a YouTube sign-in cookie; reads names only. */
async function signedIn(cdpUrl: string) {
  const version = (await (
    await fetch(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(5000),
    })
  ).json()) as { webSocketDebuggerUrl: string };
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const reply = new Promise<{
      result?: { cookies?: { name: string; domain: string }[] };
    }>((resolve) =>
      socket.addEventListener(
        "message",
        (event) => resolve(JSON.parse(String(event.data))),
        { once: true },
      ),
    );
    socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" }));
    const cookies = (await reply).result?.cookies ?? [];
    return cookies.some(
      (cookie) =>
        cookie.name === "LOGIN_INFO" && cookie.domain.endsWith("youtube.com"),
    );
  } finally {
    socket.close();
  }
}

/**
 * Classifies the test browser's account. A read runs only once a sign-in
 * cookie exists, so a signed-out browser costs one CDP call per poll.
 */
export function accountProbe(
  cdpUrl: string,
  personalAccountId: string,
  connect: (url: string) => Promise<Live>,
) {
  return async (): Promise<AccountState> => {
    if (!(await signedIn(cdpUrl))) return { state: "signed-out" };
    const live = await connect(cdpUrl);
    try {
      const result = await live.call("youtube_list_playlists", { limit: 1 });
      if (result.isError) {
        const code = live.code(result);
        // Signed in yet without a channel ID: the account has no channel.
        return code === "AUTH_REQUIRED"
          ? { state: "no-channel" }
          : { state: "error", code };
      }
      const accountId = String(result.structuredContent?.account_id ?? "");
      return accountId === personalAccountId
        ? { state: "personal" }
        : { state: "ready", accountId };
    } finally {
      await live.close();
    }
  };
}
