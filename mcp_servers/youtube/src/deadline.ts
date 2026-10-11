import { SafeError } from "./errors.ts";

/** Bound the caller's wait as well as cooperative network operations. */
export async function withDeadline<T>(
  parent: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort();
      reject(new SafeError("UPSTREAM_UNAVAILABLE"));
    };
    parent.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeError("TIMEOUT"));
    }, timeoutMs);
    if (parent.aborted) onAbort();
  });
  try {
    return await Promise.race([
      interrupted,
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
