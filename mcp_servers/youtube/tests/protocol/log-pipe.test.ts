import { expect, test } from "bun:test";
import { worker } from "../fixtures/log-process.ts";

test("real stderr backpressure preserves worker progress and recovers complete JSONL", async () => {
  const w = worker();
  try {
    expect((await w.next()).ready).toBe(true);
    w.child.stdin.write("flood\n");
    const report = await w.next();
    expect(report.flooded).toBe(true);
    expect(report.maxRecords).toBeLessThanOrEqual(256);
    expect(report.maxBytes).toBeLessThanOrEqual(256 * 1024);
    expect(report.usage.records).toBeGreaterThan(0);
    expect(report.usage.dropped).toBeGreaterThan(0);
    let stderr = "";
    w.child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const drained = new Promise<void>((resolve) =>
      w.child.stderr.once("end", resolve),
    );
    w.child.stdin.end("close\n");
    expect((await w.next()).closed).toBe(true);
    expect(await w.exited).toBe(0);
    await drained;
    const records = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const losses = records
      .filter((record) => record.event === "logs.dropped")
      .reduce((sum, record) => sum + record.count, 0);
    expect(losses).toBe(report.usage.dropped);
    expect(
      records.filter((record) => record.event === "server.start").length +
        losses,
    ).toBe(30000);
  } finally {
    w.child.kill("SIGKILL");
    await w.exited;
  }
}, 10000);

test("real broken stderr disables logging without killing worker", async () => {
  const w = worker();
  try {
    await w.next();
    w.child.stderr.destroy();
    w.child.stdin.write("flood\n");
    const report = await w.next();
    expect(report.flooded).toBe(true);
    expect(report.usage.disabled).toBe(true);
    w.child.stdin.end("close\n");
    expect((await w.next()).closed).toBe(true);
    expect(await w.exited).toBe(0);
  } finally {
    w.child.kill("SIGKILL");
    await w.exited;
  }
}, 10000);
