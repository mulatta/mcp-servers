import { expect, test } from "bun:test";
import { readLogLevel } from "../../src/config.ts";
import {
  CorrelationId,
  serialize,
  type LogEvent,
} from "../../src/observability/logger.ts";

const timestamp = new Date("2026-10-11T00:00:00.000Z");

test("JSONL permits only diagnostic fields and filters by event severity", () => {
  const events: LogEvent[] = [
    { event: "server.fatal", code: "PROCESS_FAILURE" },
    { event: "logs.dropped", count: 3 },
    { event: "server.start" },
    {
      event: "stage.start",
      stage: "cdp.connect",
      stage_id: new CorrelationId(),
      refresh_id: new CorrelationId(),
    },
  ];
  const expected = { error: 1, warn: 2, info: 3, debug: 4 };
  for (const level of ["error", "warn", "info", "debug"] as const) {
    const lines = events
      .map((event) => serialize(event, level, timestamp))
      .filter(Boolean);
    expect(lines).toHaveLength(expected[level]);
    for (const line of lines) {
      expect(line!.split("\n")).toHaveLength(2);
      expect(JSON.parse(line!).timestamp).toBe("2026-10-11T00:00:00.000Z");
    }
  }
  const event = {
    event: "server.start" as const,
    cookie: "secret\ncredential",
    message: new Error("private"),
  };
  expect(JSON.parse(serialize(event, "info", timestamp)!)).toEqual({
    schema_version: 1,
    timestamp: "2026-10-11T00:00:00.000Z",
    level: "info",
    event: "server.start",
  });
});

test("request and stage records retain safe timing, results and generated correlation only", () => {
  const request_id = new CorrelationId();
  const stage_id = new CorrelationId();
  const event: LogEvent = {
    event: "request.end",
    request_id,
    tool: "youtube_get_playlist",
    limit: 5,
    outcome: "ok",
    duration_ms: 12.5,
    returned_count: 3,
    auth_cache: "hit",
    page_cache: "replay",
  };
  const line = serialize(
    {
      ...event,
      ...{
        playlist_id: "private-id",
        title: "private-title",
        cursor: "private-cursor",
      },
    },
    "info",
    timestamp,
  )!;
  expect(JSON.parse(line)).toMatchObject({
    event: "request.end",
    request_id: request_id.value,
    duration_ms: 12.5,
    returned_count: 3,
    level: "info",
  });
  expect(line).not.toContain("private-");
  expect(
    serialize({ ...event, duration_ms: Infinity }, "info"),
  ).toBeUndefined();
  expect(serialize({ ...event, duration_ms: NaN }, "info")).toBeUndefined();
  expect(serialize({ ...event, limit: 101 }, "info")).toBeUndefined();
  expect(serialize({ ...event, duration_ms: -1 }, "info")).toBeUndefined();
  expect(
    serialize(
      JSON.parse('{"event":"request.end","request_id":"private-id"}'),
      "info",
    ),
  ).toBeUndefined();
  for (const outcome of ["error", "timeout", "cancelled"] as const) {
    const failed: LogEvent = {
      event: "request.end",
      request_id,
      tool: "youtube_get_watch_later",
      limit: 5,
      outcome,
      duration_ms: 20,
      code: "TIMEOUT",
      active_stages: [{ stage: "upstream.request", stage_id }],
    };
    expect(JSON.parse(serialize(failed, "warn", timestamp)!)).toMatchObject({
      level: "warn",
      outcome,
      code: "TIMEOUT",
    });
    expect(serialize(failed, "error")).toBeUndefined();
  }
  const ended: LogEvent = {
    event: "stage.end",
    request_id,
    stage_id,
    stage: "normalize",
    outcome: "ok",
    duration_ms: 2,
  };
  expect(JSON.parse(serialize(ended, "debug", timestamp)!)).toMatchObject({
    stage_id: stage_id.value,
    level: "debug",
    duration_ms: 2,
  });
  expect(serialize(ended, "info")).toBeUndefined();
  expect(
    JSON.parse(
      serialize(
        { event: "server.stop", reason: "SIGTERM" },
        "info",
        timestamp,
      )!,
    ),
  ).toMatchObject({ event: "server.stop", reason: "SIGTERM" });
  expect(
    JSON.parse(
      serialize(
        { event: "config.invalid", code: "INVALID_LOG_LEVEL" },
        "error",
        timestamp,
      )!,
    ),
  ).toMatchObject({ level: "error", code: "INVALID_LOG_LEVEL" });
});

test("log level defaults to info and rejects unsafe configuration without echoing it", () => {
  expect(readLogLevel({})).toBe("info");
  for (const level of ["error", "warn", "info", "debug"] as const)
    expect(readLogLevel({ YOUTUBE_LOG_LEVEL: level })).toBe(level);
  for (const value of ["", "INFO", "off", "secret\ncredential"])
    expect(() => readLogLevel({ YOUTUBE_LOG_LEVEL: value })).toThrow(
      "Invalid log level.",
    );
});
