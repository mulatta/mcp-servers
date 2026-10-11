import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ReadInput, ToolName } from "../src/server.ts";
import { resultSchema } from "../src/youtube/normalize.ts";
import { SafeError } from "../src/errors.ts";

/** Caller controls iteration; failures never silently restart and duplicate data. */
export async function* walk(client: Client, name: ToolName, input: ReadInput) {
  let cursor = input.cursor;
  do {
    const response = await client.callTool({
      name,
      arguments: { ...input, ...(cursor ? { cursor } : {}) },
    });
    if (response.isError) {
      const content = response.content;
      if (Array.isArray(content))
        for (const item of content) {
          if (
            item.type === "text" &&
            typeof item.text === "string" &&
            JSON.parse(item.text).code === "CURSOR_EXPIRED"
          )
            throw new SafeError("CURSOR_EXPIRED");
        }
      throw new Error("Read failed; do not append a restarted traversal.");
    }
    const result = resultSchema.parse(response.structuredContent);
    yield result;
    cursor = result.next_cursor ?? undefined;
  } while (cursor);
}
