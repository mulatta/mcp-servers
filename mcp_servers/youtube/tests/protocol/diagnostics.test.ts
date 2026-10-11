import { expect, test } from "bun:test";
import { DiagnosticCollector } from "../integration/diagnostics.ts";
import { serialize } from "../../src/observability/logger.ts";
import { worker } from "../fixtures/log-process.ts";

test("diagnostics accept fragmented safe JSONL without retaining raw records", () => {
  const collector = new DiagnosticCollector();
  const bytes = Buffer.from(serialize({ event: "server.start" }, "info")!);
  for (const byte of bytes) collector.push(Uint8Array.of(byte));
  expect(collector.finish()).toEqual({
    valid: true,
    records: 1,
    bytes: bytes.length,
  });
});

for (const bad of [
  "raw-private-exception\n",
  "{",
  "\n",
  "x".repeat(256 * 1024 + 1),
  JSON.stringify({
    schema_version: 1,
    timestamp: "2026-10-11T00:00:00.000Z",
    level: "info",
    event: "server.start",
    cookie: "private-cookie",
  }) + "\n",
  JSON.stringify({
    schema_version: 1,
    timestamp: "2026-10-11T00:00:00.000Z",
    level: "debug",
    event: "server.start",
  }) + "\n",
])
  test("malformed, truncated, oversized or unsafe diagnostics produce only a safe verdict", () => {
    const collector = new DiagnosticCollector();
    collector.push(Buffer.from(bad));
    const verdict = collector.finish();
    expect(verdict.valid).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain("private");
  });

test("actual server lifecycle diagnostics are valid despite nonzero stderr", async () => {
  const w = worker(true);
  const collector = new DiagnosticCollector();
  w.child.stderr.on("data", (chunk) => collector.push(chunk));
  const drained = new Promise<void>((resolve) =>
    w.child.stderr.once("end", resolve),
  );
  try {
    await w.next();
    w.child.stdin.end();
    expect(await w.exited).toBe(0);
    await drained;
    expect(collector.finish()).toMatchObject({ valid: true, records: 2 });
    expect(collector.finish().bytes).toBeGreaterThan(0);
  } finally {
    w.child.kill("SIGKILL");
    await w.exited;
  }
});
