import { Writable } from "node:stream";
import { Logger, validDiagnostic } from "../../src/observability/logger.ts";
import type { LogLevel } from "../../src/config.ts";

export function captureDiagnostics(level: LogLevel = "debug") {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const logger = new Logger(level, sink);
  return {
    logger,
    async finish() {
      await logger.close();
      sink.destroy();
      const records = lines.map((line) => JSON.parse(line));
      if (!records.every(validDiagnostic))
        throw new Error("Invalid diagnostic record.");
      return records;
    },
  };
}
