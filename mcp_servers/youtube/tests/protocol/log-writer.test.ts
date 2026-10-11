import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { BoundedWriter } from "../../src/observability/writer.ts";
import { Logger } from "../../src/observability/logger.ts";

function collector(highWaterMark = 1) {
  const lines: string[] = [];
  let release: (() => void) | undefined;
  let stalled = true;
  const sink = new Writable({
    highWaterMark,
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      if (stalled) release = done;
      else done();
    },
  });
  return {
    sink,
    lines,
    resume() {
      stalled = false;
      release?.();
    },
  };
}

test("bounded writer counts pending stream writes and drops new records until recovery", async () => {
  const c = collector();
  const writer = new BoundedWriter(
    c.sink,
    (count) => JSON.stringify({ dropped: count }) + "\n",
  );
  for (let i = 0; i < 300; i++) writer.write(JSON.stringify({ i }) + "\n");
  await Bun.sleep(0);
  expect(writer.usage.records).toBe(256);
  expect(writer.usage.dropped).toBe(44);
  expect(c.lines).toEqual(['{"i":0}\n']);
  c.resume();
  await writer.close();
  expect(c.lines).toHaveLength(257);
  expect(c.lines.at(-1)).toBe('{"dropped":44}\n');
  expect(writer.usage.records).toBe(0);
  expect(writer.usage.bytes).toBe(0);
  c.sink.destroy();
});

test("byte cap counts UTF-8 and newlines and drops oversized records whole", async () => {
  const c = collector();
  const writer = new BoundedWriter(
    c.sink,
    (count) => JSON.stringify({ dropped: count }) + "\n",
  );
  const line = JSON.stringify({ text: "가".repeat(10000) }) + "\n";
  for (let i = 0; i < 10; i++) writer.write(line);
  writer.write(JSON.stringify({ text: "가".repeat(100000) }) + "\n");
  await Bun.sleep(0);
  expect(writer.usage).toMatchObject({ records: 8, bytes: 240096, dropped: 3 });
  c.resume();
  await writer.close();
  expect(c.lines).toHaveLength(9);
  expect(c.lines.at(-1)).toBe('{"dropped":3}\n');
  for (const record of c.lines) expect(() => JSON.parse(record)).not.toThrow();
  c.sink.destroy();
});

test("stream internal queue remains inside the outstanding credit budget", async () => {
  const c = collector(1024 * 1024);
  const writer = new BoundedWriter(c.sink, () => undefined);
  for (let i = 0; i < 1000; i++) writer.write("{}\n");
  await Bun.sleep(0);
  expect(writer.usage).toMatchObject({
    records: 256,
    bytes: 768,
    dropped: 744,
  });
  expect(c.sink.writableLength).toBe(768);
  c.resume();
  await writer.close();
  expect(c.lines).toHaveLength(256);
  c.sink.destroy();
});

for (const mode of ["callback", "throw", "close"] as const)
  test(`sink ${mode} failures are isolated without recursive output`, async () => {
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        if (mode === "callback") done(new Error("private-sink-error"));
        if (mode === "throw") throw new Error("private-sink-error");
        if (mode === "close") this.destroy();
      },
    });
    const writer = new BoundedWriter(sink, () => "{}\n");
    writer.write("{}\n");
    await Bun.sleep(0);
    await writer.close();
    writer.write("{}\n");
    expect(writer.usage).toMatchObject({
      disabled: true,
      records: 0,
      bytes: 0,
    });
    sink.destroy();
  });

test("logger filters loss summaries at error level without leaking sink failures", async () => {
  for (const level of ["info", "error"] as const) {
    const c = collector();
    const logger = new Logger(level, c.sink);
    for (let i = 0; i < 300; i++)
      logger.emit({ event: "server.fatal", code: "PROCESS_FAILURE" });
    await Bun.sleep(0);
    expect(logger.usage.records).toBe(256);
    c.resume();
    await logger.close();
    const records = c.lines.map((line) => JSON.parse(line));
    expect(
      records.filter((record) => record.event === "server.fatal"),
    ).toHaveLength(256);
    const losses = records.filter((record) => record.event === "logs.dropped");
    expect(losses).toHaveLength(level === "info" ? 1 : 0);
    if (level === "info") expect(losses[0].count).toBe(44);
    c.sink.destroy();
  }
});

test("shutdown has a one second flush budget even when consumer never resumes", async () => {
  const c = collector();
  const writer = new BoundedWriter(c.sink, () => undefined);
  writer.write("{}\n");
  const started = performance.now();
  const closing = writer.close();
  expect(writer.close()).toBe(closing);
  await closing;
  expect(performance.now() - started).toBeLessThan(1200);
  expect(writer.usage.records).toBe(0);
  c.sink.destroy(new Error("late failure"));
  await Bun.sleep(0);
});
