import { start } from "../../src/index.ts";
import { createReader } from "../../src/reader.ts";

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
  { timeoutMs: 200 },
);
