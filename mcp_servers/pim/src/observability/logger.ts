import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { Writable } from "node:stream";
import { BoundedWriter } from "./writer.ts";
import { writeGroups, type LogLevel } from "../config.ts";
import { isErrorCode, type ErrorCode } from "../errors.ts";

// Every field is a fixed name, count, duration, status or code. Tokens, codes
// shown to the user, account names, addresses, IDs, subjects and bodies have
// no field to go into, and unknown properties are stripped.
const duration = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const code = z.custom<ErrorCode>(isErrorCode);
const toolName = z.string().regex(/^pim_[a-z_]{1,48}$/);
// JMAP method names such as Email/set; anything else is never logged.
const methodName = z
  .string()
  .regex(/^[A-Z][A-Za-z]{0,31}\/[a-z][A-Za-z]{0,31}$/);
const outcome = z.enum(["ok", "error", "timeout", "cancelled"]);

const eventSchema = z.union([
  z.object({
    event: z.literal("server.start"),
    writes: z.array(z.enum(writeGroups)).optional(),
  }),
  z.object({
    event: z.literal("server.stop"),
    reason: z.enum(["SIGINT", "SIGTERM", "transport_closed"]),
  }),
  z.object({
    event: z.literal("server.fatal"),
    code: z.literal("PROCESS_FAILURE"),
  }),
  z.object({
    event: z.literal("config.invalid"),
    code: z.enum([
      "INVALID_LOG_LEVEL",
      "INVALID_SERVER",
      "INVALID_TRANSPORT",
      "INVALID_HTTP_CONFIG",
      "INVALID_WRITES",
    ]),
  }),
  z.object({
    event: z.literal("http.rejected"),
    status: z.union([
      z.literal(401),
      z.literal(403),
      z.literal(404),
      z.literal(405),
    ]),
  }),
  z.object({ event: z.literal("logs.dropped"), count: count.positive() }),
  z.object({
    event: z.literal("auth.refresh"),
    trigger: z.enum(["request", "background", "unauthorized"]),
    outcome: z.enum(["ok", "error"]),
    rotated: z.boolean().optional(),
    code: code.optional(),
    http_status: z.number().int().min(100).max(599).optional(),
    duration_ms: duration,
  }),
  z.object({
    event: z.literal("state.write_failed"),
    code: z.literal("STATE_WRITE_FAILED"),
  }),
  z.object({
    event: z.literal("upstream.write"),
    methods: z.array(methodName).max(16),
    confirmed: z.boolean(),
    http_status: z.number().int().min(100).max(599).optional(),
  }),
  z.object({
    event: z.literal("request.end"),
    tool: toolName,
    outcome,
    code: code.optional(),
    returned_count: count.optional(),
    duration_ms: duration,
  }),
]);
export type LogEvent = z.input<typeof eventSchema>;

const wireSchema = eventSchema.and(
  z.object({
    schema_version: z.literal(1),
    timestamp: z.iso.datetime(),
    level: z.enum(["error", "warn", "info", "debug"]),
  }),
);

export function validDiagnostic(value: unknown): boolean {
  const parsed = wireSchema.safeParse(value);
  return (
    parsed.success &&
    isDeepStrictEqual(value, parsed.data) &&
    parsed.data.level === severity(parsed.data)
  );
}

function severity(data: {
  event: string;
  outcome?: string | undefined;
}): LogLevel {
  switch (data.event) {
    case "server.fatal":
    case "config.invalid":
    case "state.write_failed":
      return "error";
    case "logs.dropped":
    case "http.rejected":
      return "warn";
    case "auth.refresh":
    case "request.end":
      return data.outcome === "ok" ? "info" : "warn";
    case "upstream.write":
      return "debug";
    default:
      return "info";
  }
}
const priority = { error: 0, warn: 1, info: 2, debug: 3 };

export class Logger {
  private writer: BoundedWriter;
  constructor(
    private level: LogLevel,
    sink: Writable = process.stderr,
  ) {
    this.writer = new BoundedWriter(sink, (count) =>
      serialize({ event: "logs.dropped", count }, level),
    );
  }

  emit(event: LogEvent) {
    const line = serialize(event, this.level);
    if (line !== undefined) this.writer.write(line);
  }

  close() {
    return this.writer.close();
  }
}

export function serialize(
  event: LogEvent,
  threshold: LogLevel,
  timestamp = new Date(),
): string | undefined {
  try {
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) return;
    const data = parsed.data;
    const level = severity(data);
    if (priority[level] > priority[threshold]) return;
    return (
      JSON.stringify({
        schema_version: 1,
        timestamp: timestamp.toISOString(),
        level,
        ...data,
      }) + "\n"
    );
  } catch {
    // A diagnostic failure must not replace the operation's result.
    return;
  }
}
