import { expect, test } from "bun:test";
import { worker } from "../fixtures/log-process.ts";

for (const reason of ["eof", "signals"] as const)
  test(`server shutdown via ${reason} emits one terminal event`, async () => {
    const w = worker(true);
    let stderr = "";
    w.child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const drained = new Promise<void>((resolve) =>
      w.child.stderr.once("end", resolve),
    );
    try {
      await w.next();
      if (reason === "eof") w.child.stdin.end();
      else {
        w.child.kill("SIGINT");
        w.child.kill("SIGTERM");
      }
      expect(await w.exited).toBe(0);
      await drained;
      const events = stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.filter((event) => event.event === "server.stop"),
      ).toHaveLength(1);
      if (reason === "eof")
        expect(events.at(-1).reason).toBe("transport_closed");
      else expect(["SIGINT", "SIGTERM"]).toContain(events.at(-1).reason);
      expect(events.some((event) => event.event === "server.fatal")).toBe(
        false,
      );
    } finally {
      w.child.kill("SIGKILL");
      await w.exited;
    }
  });

for (const broken of [false, true])
  test(`server shutdown stays bounded with unavailable stderr (broken=${broken})`, async () => {
    const w = worker(true);
    try {
      await w.next();
      if (broken) w.child.stderr.destroy();
      w.child.stdin.write("flood\n");
      const report = await w.next();
      if (broken) expect(report.usage.disabled).toBe(true);
      else expect(report.usage.records).toBeGreaterThan(0);
      const started = performance.now();
      w.child.kill("SIGTERM");
      expect(await w.exited).toBe(0);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      w.child.kill("SIGKILL");
      await w.exited;
    }
  }, 10000);
