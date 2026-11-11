/** Evaluates expressions in one page target over its DevTools socket. */
async function page(url: string) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  return {
    evaluate: <T>(expression: string) =>
      new Promise<T | undefined>((resolve) => {
        const id = ++next;
        const listen = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          socket.removeEventListener("message", listen);
          resolve(message.result?.result?.value);
        };
        socket.addEventListener("message", listen);
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        );
      }),
    close: () => socket.close(),
  };
}

// The main video's position, or -1 while an ad plays or nothing has loaded.
const position = `(() => {
  const player = document.querySelector("#movie_player");
  const video = document.querySelector("video");
  if (!player || !video || player.classList.contains("ad-showing")) return -1;
  return video.currentTime;
})()`;

/**
 * Watch history has no write tool, so the test browser plays the video in
 * its own tab, as a viewer would, until the video itself (not an ad before
 * it, which records nothing) has run for `seconds`. Autoplay is allowed by
 * the test browser's policy.
 */
export async function watch(cdpUrl: string, video: string, seconds = 15) {
  const url = `https://www.youtube.com/watch?v=${video}`;
  const target = (await (
    await fetch(new URL(`/json/new?${encodeURIComponent(url)}`, cdpUrl), {
      method: "PUT",
    })
  ).json()) as { id: string; webSocketDebuggerUrl: string };
  try {
    const tab = await page(target.webSocketDebuggerUrl);
    try {
      const deadline = Date.now() + 120_000;
      while (((await tab.evaluate<number>(position)) ?? -1) < seconds) {
        if (Date.now() > deadline) throw new Error("the video did not play");
        await Bun.sleep(1000);
      }
    } finally {
      tab.close();
    }
  } finally {
    await fetch(new URL(`/json/close/${target.id}`, cdpUrl));
  }
}
