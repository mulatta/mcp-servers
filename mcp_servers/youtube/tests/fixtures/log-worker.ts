import { createInterface } from "node:readline";
import { Logger } from "../../src/observability/logger.ts";

const logger = new Logger("info");
console.log(JSON.stringify({ ready: true }));
for await (const command of createInterface({ input: process.stdin })) {
  if (command === "flood") {
    let maxRecords = 0;
    let maxBytes = 0;
    for (let batch = 0; batch < 100; batch++) {
      for (let i = 0; i < 300; i++) logger.emit({ event: "server.start" });
      maxRecords = Math.max(maxRecords, logger.usage.records);
      maxBytes = Math.max(maxBytes, logger.usage.bytes);
      await Bun.sleep(0);
    }
    console.log(
      JSON.stringify({
        flooded: true,
        usage: logger.usage,
        maxRecords,
        maxBytes,
      }),
    );
  }
  if (command === "close") {
    await logger.close();
    console.log(JSON.stringify({ closed: true, usage: logger.usage }));
    break;
  }
}
