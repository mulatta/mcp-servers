import { expect, test } from "bun:test";
import { Paginator } from "../../src/pagination.ts";
import { withRequest } from "../../src/observability/trace.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { libraryServer } from "../fixtures/library-server.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";

test("buffer and replay traces do not invent upstream reads or reveal cursors", async () => {
  let now = 0;
  const f = libraryServer({ pages: [4], now: () => now });
  const pages = new Paginator(f.sessions, { now: () => now });
  const c = captureDiagnostics();
  const call = async (cursor?: string) =>
    resultSchema.parse(
      await withRequest(c.logger, "youtube_get_watch_later", 1, () =>
        pages.read(
          "youtube_get_watch_later",
          { limit: 1, cursor },
          new AbortController().signal,
        ),
      ),
    );
  try {
    const first = await call();
    const cursor = first.next_cursor!;
    const next = await call(cursor);
    expect(await call(cursor)).toEqual(next);
    expect(f.reads).toBe(1);
    now = 300000;
    await expect(call(cursor)).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
    });
    f.accountId = "UCbbbbbbbbbbbbbbbbbbbbbb";
    await expect(call()).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await expect(call(cursor)).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
    const records = await c.finish();
    const summaries = records.filter((r) => r.event === "request.end");
    expect(summaries.slice(0, 3).map((r) => r.page_cache)).toEqual([
      "miss",
      "buffer",
      "replay",
    ]);
    for (const summary of summaries.slice(1, 3))
      expect(
        records.filter(
          (r) =>
            r.request_id === summary.request_id &&
            r.stage === "upstream.request",
        ),
      ).toHaveLength(0);
    expect(JSON.stringify(records)).not.toContain(cursor);
    expect(
      records.filter(
        (r) => r.event === "stage.end" && r.stage === "pagination",
      ),
    ).toHaveLength(6);
  } finally {
    f.close();
  }
});

test("concurrent cursor computation records a waiter, not duplicated upstream work", async () => {
  const f = libraryServer({ pages: [1, 1] });
  const pages = new Paginator(f.sessions);
  const c = captureDiagnostics();
  const call = async (cursor?: string) =>
    resultSchema.parse(
      await withRequest(c.logger, "youtube_get_watch_later", 1, () =>
        pages.read(
          "youtube_get_watch_later",
          { limit: 1, cursor },
          new AbortController().signal,
        ),
      ),
    );
  try {
    const first = await call();
    const [a, b] = await Promise.all([
      call(first.next_cursor!),
      call(first.next_cursor!),
    ]);
    expect(a).toEqual(b);
    expect(f.reads).toBe(2);
    const records = await c.finish();
    const summaries = records.filter((r) => r.event === "request.end");
    expect(summaries.map((r) => r.page_cache).sort()).toEqual([
      "miss",
      "miss",
      "shared",
    ]);
    const waiter = summaries.find((r) => r.page_cache === "shared");
    expect(
      records.filter(
        (r) =>
          r.request_id === waiter.request_id && r.stage === "upstream.request",
      ),
    ).toHaveLength(0);
  } finally {
    f.close();
  }
});
