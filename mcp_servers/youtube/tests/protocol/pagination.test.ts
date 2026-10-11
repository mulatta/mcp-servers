import { expect, test } from "bun:test";
import { Paginator } from "../../src/pagination.ts";
import { libraryServer } from "../fixtures/library-server.ts";

const signal = () => new AbortController().signal;
const name = "youtube_get_watch_later";

test("100 upstream items with limit 20 retain leftovers, order, duplicates and replay", async () => {
  const f = libraryServer({ pages: [100, 3] });
  const pager = new Paginator(f.sessions);
  try {
    let result = await pager.read(name, { limit: 20 }, signal());
    const all = [...result.items];
    const cursor = result.next_cursor!;
    const [a, b] = await Promise.all([
      pager.read(name, { limit: 20, cursor }, signal()),
      pager.read(name, { limit: 20, cursor }, signal()),
    ]);
    expect(a).toEqual(b);
    expect(await pager.read(name, { limit: 20, cursor }, signal())).toEqual(a);
    expect(f.reads).toBe(1);
    result = a;
    all.push(...result.items);
    while (result.next_cursor) {
      result = await pager.read(
        name,
        { limit: 20, cursor: result.next_cursor },
        signal(),
      );
      all.push(...result.items);
    }
    expect(all).toHaveLength(103);
    expect(all.map((x) => x.title)).toEqual(
      Array.from({ length: 103 }, (_, i) => `Fixture ${i}`),
    );
    expect(f.reads).toBe(2);
    expect(result.has_more).toBe(false);
    expect(JSON.stringify(all)).not.toContain("SAPISID");
  } finally {
    f.close();
  }
});

test("cursor arguments, missing state and restart are distinguished", async () => {
  const f = libraryServer({ pages: [4] });
  const pager = new Paginator(f.sessions);
  try {
    const { next_cursor: cursor } = await pager.read(
      name,
      { limit: 1 },
      signal(),
    );
    for (const [tool, args] of [
      [name, { limit: 2, cursor: cursor! }],
      ["youtube_get_liked_videos", { limit: 1, cursor: cursor! }],
    ] as const)
      await expect(pager.read(tool, args, signal())).rejects.toMatchObject({
        code: "CURSOR_INVALID",
      });
    await expect(
      pager.read(name, { limit: 1, cursor: "bad" }, signal()),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(
      new Paginator(f.sessions).read(
        name,
        { limit: 1, cursor: cursor! },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  } finally {
    f.close();
  }
});

test("empty intermediate pages can be followed without dropping later items", async () => {
  const f = libraryServer({ pages: [1, 0, 0, 1] });
  const pager = new Paginator(f.sessions);
  try {
    const result = await pager.read(name, { limit: 2 }, signal());
    expect(result.items.map((x) => x.title)).toEqual([
      "Fixture 0",
      "Fixture 1",
    ]);
    expect(result.next_cursor).toBeNull();
  } finally {
    f.close();
  }
});
