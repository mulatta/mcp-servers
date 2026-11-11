import { Writable } from "node:stream";
import { Logger } from "../../src/observability/logger.ts";

/** A debug-level logger whose records are parsed back for assertions. */
export function captureLogs() {
  const records: Record<string, unknown>[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).split("\n"))
        if (line) records.push(JSON.parse(line));
      done();
    },
  });
  const logger = new Logger("debug", sink);
  return {
    logger,
    records,
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}
