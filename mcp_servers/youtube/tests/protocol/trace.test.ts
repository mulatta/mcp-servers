import { expect, test } from "bun:test";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";
import {
  withRequest,
  stage,
  createRefresh,
  linkRefresh,
} from "../../src/observability/trace.ts";

test("parallel requests keep independent stage trees and generated IDs", async () => {
  const c = captureDiagnostics();
  await Promise.all(
    [1, 2].map((limit) =>
      withRequest(c.logger, "youtube_get_watch_later", limit, async () => {
        await stage("pagination", async () => {
          await stage("upstream.request", () => Bun.sleep(limit));
          await stage("normalize", () => ({ private_title: "secret-title" }));
        });
        return { items: ["secret-video-id"] };
      }),
    ),
  );
  const events = await c.finish();
  const requests = events.filter((event) => event.event === "request.end");
  expect(requests).toHaveLength(2);
  expect(new Set(requests.map((event) => event.request_id)).size).toBe(2);
  for (const request of requests) {
    expect(request.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const own = events.filter(
      (event) => event.request_id === request.request_id,
    );
    const starts = own.filter((event) => event.event === "stage.start");
    const ends = own.filter((event) => event.event === "stage.end");
    expect(starts).toHaveLength(3);
    expect(ends).toHaveLength(3);
    const parent = starts.find((event) => event.stage === "pagination");
    expect(
      starts.filter((event) => event.parent_stage_id === parent.stage_id),
    ).toHaveLength(2);
    for (const end of ends) {
      expect(end.duration_ms).toBeGreaterThanOrEqual(0);
      expect(end.duration_ms).toBeLessThanOrEqual(request.duration_ms);
    }
  }
  expect(JSON.stringify(events)).not.toContain("secret-");
});

test("shared refresh stages belong to refresh, not their first request", async () => {
  const c = captureDiagnostics();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let refresh: ReturnType<typeof createRefresh>;
  let loading: Promise<void> | undefined;
  const requests = [1, 2].map((limit) =>
    withRequest(c.logger, "youtube_get_watch_later", limit, async () => {
      await stage("auth.wait", async () => {
        refresh ??= createRefresh();
        loading ??= refresh!.run(() => stage("cdp.cookies", () => gate));
        const unlink = linkRefresh(refresh);
        try {
          await loading;
        } finally {
          unlink();
        }
      });
      return { items: [] };
    }),
  );
  release();
  await Promise.all(requests);
  const records = await c.finish();
  const shared = records.filter(
    (record) => record.refresh_id && !record.request_id,
  );
  expect(shared).toHaveLength(4);
  expect(new Set(shared.map((record) => record.refresh_id)).size).toBe(1);
  const waits = records.filter(
    (record) => record.event === "stage.end" && record.stage === "auth.wait",
  );
  expect(waits).toHaveLength(2);
  expect(
    waits.every((record) => record.refresh_id === shared[0].refresh_id),
  ).toBe(true);
  expect(new Set(waits.map((record) => record.request_id)).size).toBe(2);
});

test("callbacks retaining a completed request cannot create late stages", async () => {
  const c = captureDiagnostics();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let late: Promise<number> | undefined;
  await withRequest(c.logger, "youtube_get_watch_later", 1, async () => {
    await stage("normalize", () => 1);
    late = gate.then(() => stage("normalize", () => 2));
    return { items: [] };
  });
  release();
  expect(await late).toBe(2);
  expect((await c.finish()).map((record) => record.event)).toEqual([
    "stage.start",
    "stage.end",
    "request.end",
  ]);
});

test("untraced operations keep results and errors without output", async () => {
  expect(await stage("normalize", () => 7)).toBe(7);
  await expect(
    stage("normalize", () => {
      throw new Error("unchanged");
    }),
  ).rejects.toThrow("unchanged");
  expect(
    await withRequest(undefined, "youtube_get_watch_later", 1, async () => ({
      items: [],
    })),
  ).toEqual({ items: [] });
});
