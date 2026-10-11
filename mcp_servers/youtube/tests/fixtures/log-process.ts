import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function worker(server = false) {
  const child = spawn(
    process.execPath,
    [
      new URL("./log-worker.ts", import.meta.url).pathname,
      ...(server ? ["--server"] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const reader = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  async function next() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        reader.next(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Diagnostic pipe blocked progress.")),
            3000,
          );
        }),
      ]);
      if (result.done) throw new Error("Diagnostic worker exited early.");
      return JSON.parse(result.value);
    } finally {
      clearTimeout(timer);
    }
  }
  return { child, exited, next };
}
