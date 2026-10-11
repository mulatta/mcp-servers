import { z } from "zod";
import type { Writable } from "node:stream";
import { BoundedWriter } from "./writer.ts";
import type { LogLevel } from "../config.ts";
import { isErrorCode, type ErrorCode } from "../errors.ts";

export class CorrelationId {
  readonly value = crypto.randomUUID();
  constructor() {
    Object.freeze(this);
  }
}

const id = z.instanceof(CorrelationId).transform((value) => value.value);
const duration = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const code = z.custom<ErrorCode>(isErrorCode);
const stage = z.enum([
  "auth.wait",
  "auth.refresh",
  "cdp.connect",
  "cdp.cookies",
  "auth.identity",
  "upstream.request",
  "normalize",
  "pagination",
]);
export type Stage = z.infer<typeof stage>;
const authCache = z.enum(["hit", "miss", "shared", "mixed"]);
const pageCache = z.enum(["miss", "buffer", "replay", "shared", "mixed"]);
const outcome = z.enum(["ok", "error", "timeout", "cancelled"]);
const reference = z.object({ stage, stage_id: id, refresh_id: id.optional() });
export type StageReference = z.input<typeof reference>;
const scope = {
  request_id: id.optional(),
  refresh_id: id.optional(),
  stage_id: id,
  parent_stage_id: id.optional(),
  stage,
};
const caches = {
  auth_cache: authCache.optional(),
  page_cache: pageCache.optional(),
};
const request = {
  event: z.literal("request.end"),
  request_id: id,
  tool: z.enum([
    "youtube_list_playlists",
    "youtube_get_playlist",
    "youtube_get_watch_later",
    "youtube_get_liked_videos",
    "youtube_get_watch_history",
  ]),
  limit: z.number().int().min(1).max(100),
  duration_ms: duration,
  ...caches,
};
const eventSchema = z.union([
  z.object({ event: z.literal("server.start") }),
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
    code: z.literal("INVALID_LOG_LEVEL"),
  }),
  z.object({ event: z.literal("logs.dropped"), count: count.positive() }),
  z.object({ event: z.literal("stage.start"), ...scope }),
  z.object({
    event: z.literal("stage.end"),
    ...scope,
    ...caches,
    outcome,
    duration_ms: duration,
    code: code.optional(),
  }),
  z.object({
    ...request,
    outcome: z.literal("ok"),
    returned_count: count.max(100),
  }),
  z.object({
    ...request,
    outcome: z.enum(["error", "timeout", "cancelled"]),
    code,
    active_stages: z.array(reference).max(16).optional(),
  }),
]);
export type LogEvent = z.input<typeof eventSchema>;
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

  get usage() {
    return this.writer.usage;
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
    // Strip unknown properties instead of sanitizing arbitrary object graphs.
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) return;
    const data = parsed.data;
    const level =
      data.event === "server.fatal" || data.event === "config.invalid"
        ? "error"
        : data.event === "logs.dropped" ||
            (data.event === "request.end" && data.outcome !== "ok")
          ? "warn"
          : data.event === "stage.start" || data.event === "stage.end"
            ? "debug"
            : "info";
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
