import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WriteGroup } from "./config.ts";
import { withDeadline } from "./deadline.ts";
import { errorResult, safeError, SafeError } from "./errors.ts";
import type { Attempt, Jmap } from "./jmap/client.ts";
import type { Logger } from "./observability/logger.ts";
import { tools } from "./tools/index.ts";

// Hermes forwards only tool descriptions and error messages to its model, so
// every caveat a caller needs is in the descriptions; instructions repeat the
// rules for clients that read them.
export const instructions = [
  "This server reads, and when enabled changes, one Stalwart mail account: mail, calendars and contacts.",
  "Use IDs from read results; IDs are opaque.",
  "Writes are sent once and never retried. WRITE_OUTCOME_UNKNOWN means the change may have happened: read the target before trying again, because repeating a create or send can duplicate it.",
  "Tags are Bulwark webmail labels, shown by their ID only.",
].join(" ");

export interface ServerOptions {
  writes?: ReadonlySet<WriteGroup> | undefined;
  timeoutMs?: number | undefined;
  logger?: Logger | undefined;
}

export function createServer(jmap: Jmap, options: ServerOptions = {}) {
  const server = new McpServer(
    { name: "pim-mcp", version: "0.0.0" },
    { instructions },
  );
  for (const definition of tools) {
    if (definition.group && !options.writes?.has(definition.group)) continue;
    const write = definition.group !== undefined;
    const schema = z.strictObject(definition.input);
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.check
          ? schema.refine(definition.check)
          : schema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write && definition.destructive === true,
          idempotentHint: !write || definition.idempotent === true,
          openWorldHint: true,
        },
      },
      async (input: Record<string, unknown>, extra) => {
        const attempt: Attempt = { dispatched: false };
        const started = performance.now();
        try {
          const result = await withDeadline(
            extra.signal,
            options.timeoutMs ?? 30_000,
            (signal) => definition.run(input, { jmap, signal, attempt }),
          ).catch((error: unknown) => {
            // A write that left the process and then timed out or was
            // cancelled may still have been applied.
            const interrupted =
              !(error instanceof SafeError) ||
              error.code === "TIMEOUT" ||
              error.code === "UPSTREAM_UNAVAILABLE";
            throw write && attempt.dispatched && interrupted
              ? new SafeError("WRITE_OUTCOME_UNKNOWN")
              : error;
          });
          options.logger?.emit({
            event: "request.end",
            tool: definition.name,
            outcome: "ok",
            ...(Array.isArray(result.items)
              ? { returned_count: result.items.length }
              : {}),
            duration_ms: performance.now() - started,
          });
          return {
            structuredContent: result,
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (error) {
          const { code } = safeError(error);
          options.logger?.emit({
            event: "request.end",
            tool: definition.name,
            outcome: extra.signal.aborted
              ? "cancelled"
              : code === "TIMEOUT"
                ? "timeout"
                : "error",
            code,
            duration_ms: performance.now() - started,
          });
          return errorResult(error);
        }
      },
    );
  }
  return server;
}
