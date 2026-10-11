import { expect, test } from "bun:test";
import { Paginator } from "../../src/pagination.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const signal = () => new AbortController().signal;
const name = "youtube_get_watch_later";

test("cursor lifetime is five minutes even if session remains current", async () => {
  const f = libraryServer({ pages: [4] });
  let now = 0;
  const pager = new Paginator(f.sessions, { now: () => now });
  try {
    const result = await pager.read(name, { limit: 1 }, signal());
    now = 300_000;
    await expect(
      pager.read(name, { limit: 1, cursor: result.next_cursor! }, signal()),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(pager.usage.states).toBe(0);
  } finally {
    f.close();
  }
});

test("state count uses LRU and accounts for buffered and cached bytes", async () => {
  const f = libraryServer({ pages: [10] });
  const pager = new Paginator(f.sessions, { maxStates: 3, maxBytes: 20_000 });
  try {
    const a = await pager.read(name, { limit: 1 }, signal());
    const b = await pager.read(name, { limit: 1 }, signal());
    await pager.read(name, { limit: 1, cursor: a.next_cursor! }, signal());
    await pager.read(name, { limit: 1 }, signal());
    expect(pager.usage.states).toBe(3);
    expect(pager.usage.bytes).toBeLessThanOrEqual(20_000);
    await expect(
      pager.read(name, { limit: 1, cursor: b.next_cursor! }, signal()),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    const tiny = new Paginator(f.sessions, { maxBytes: 32 });
    await expect(tiny.read(name, { limit: 1 }, signal())).rejects.toMatchObject(
      { code: "CURSOR_EXPIRED" },
    );
    expect(tiny.usage.bytes).toBe(0);
  } finally {
    f.close();
  }
});

test("default cap retains at most 128 cursor states", async () => {
  const f = libraryServer({ pages: [2] });
  const pager = new Paginator(f.sessions);
  try {
    for (let i = 0; i < 130; i++)
      await pager.read(name, { limit: 1 }, signal());
    expect(pager.usage.states).toBe(128);
    expect(pager.usage.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  } finally {
    f.close();
  }
});

test("three additional upstream requests per page leave a usable cursor", async () => {
  const f = libraryServer({ pages: [0, 0, 0, 0, 1] });
  const pager = new Paginator(f.sessions);
  try {
    const a = await pager.read(name, { limit: 1 }, signal());
    expect(a.items).toEqual([]);
    expect(a.has_more).toBe(true);
    expect(f.reads).toBe(4);
    const b = await pager.read(
      name,
      { limit: 1, cursor: a.next_cursor! },
      signal(),
    );
    expect(b.items).toHaveLength(1);
    expect(f.reads).toBe(5);
  } finally {
    f.close();
  }
});

test("auth refresh discards cursors without replay and invalidation releases state", async () => {
  const f = libraryServer({ pages: [1, 1] });
  const pager = new Paginator(f.sessions);
  try {
    const a = await pager.read(name, { limit: 1 }, signal());
    f.authFailures = 1;
    await expect(
      pager.read(name, { limit: 1, cursor: a.next_cursor! }, signal()),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    expect(f.reads).toBe(2);
    expect(f.browser.discoveries).toBe(2);
    expect(pager.usage.states).toBe(0);
    await pager.read(name, { limit: 1 }, signal());
    f.sessions.invalidate();
    expect(pager.usage.states).toBe(0);
  } finally {
    f.close();
  }
});

test("cancellation prevents later pages and cached continuation replay", async () => {
  const f = libraryServer({ pages: [1, 1] });
  const pager = new Paginator(f.sessions);
  try {
    const a = await pager.read(name, { limit: 1 }, signal());
    const controller = new AbortController();
    controller.abort();
    await expect(
      pager.read(name, { limit: 1, cursor: a.next_cursor! }, controller.signal),
    ).rejects.toBeDefined();
    expect(f.reads).toBe(1);
  } finally {
    f.close();
  }
});
