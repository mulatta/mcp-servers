import { start } from "../../src/index.ts";
import { createReader } from "../../src/reader.ts";
import { Logger } from "../../src/observability/logger.ts";
import { readLogLevel } from "../../src/config.ts";

const logger = new Logger(readLogLevel());
if (process.env.FIXTURE_PRESSURE === "1") {
  // Fill stderr before protocol startup without adding a diagnostic MCP tool.
  for (let batch = 0; batch < 100; batch++) {
    for (let i = 0; i < 300; i++) logger.emit({ event: "server.start" });
    await Bun.sleep(0);
  }
}

await start(
  createReader({
    cdpUrl: process.env.FIXTURE_CDP!,
    network: (request) => {
      const url = new URL(request.url);
      url.protocol = "http:";
      url.host = process.env.FIXTURE_UPSTREAM!;
      return fetch(new Request(url, request));
    },
  }),
  { timeoutMs: 200, logger },
);
