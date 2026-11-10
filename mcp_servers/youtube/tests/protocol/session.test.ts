import { expect, test } from "bun:test";
import { SessionProvider } from "../../src/auth/session.ts";
import { SafeError } from "../../src/errors.ts";
import { acquireCookies } from "../../src/auth/cdp.ts";
import { cdpFixture } from "../fixtures/cdp.ts";

const signal = () => new AbortController().signal;

test("lazy snapshot and concurrent refresh share one acquisition, maximum five minutes", async () => {
  const f = cdpFixture();
  let now = 0;
  const provider = new SessionProvider(
    async (s) => ({
      accountId: "fixture-account",
      value: await acquireCookies(f.url, s),
    }),
    () => now,
  );
  try {
    expect(f.discoveries).toBe(0);
    const snapshots = await Promise.all(
      Array.from({ length: 8 }, () => provider.get(signal())),
    );
    expect(f.discoveries).toBe(1);
    expect(new Set(snapshots.map((x) => x.generation)).size).toBe(1);
    now = 299_999;
    expect((await provider.get(signal())).generation).toBe(
      snapshots[0]!.generation,
    );
    now++;
    expect((await provider.get(signal())).generation).not.toBe(
      snapshots[0]!.generation,
    );
    expect(f.discoveries).toBe(2);
  } finally {
    f.close();
  }
});

test("account change permanently locks the process and invalidates old generation", async () => {
  let now = 0;
  let id = "first";
  const provider = new SessionProvider(
    async () => ({ accountId: id, value: 1 }),
    () => now,
  );
  const first = await provider.get(signal());
  id = "second";
  now = 300_000;
  await expect(provider.get(signal())).rejects.toMatchObject({
    code: "ACCOUNT_CHANGED",
  });
  expect(provider.isCurrent(first)).toBe(false);
  id = "first";
  await expect(provider.get(signal())).rejects.toMatchObject({
    code: "ACCOUNT_CHANGED",
  });
});

test("authentication retries once, generic access failures never refresh", async () => {
  let loads = 0;
  const provider = new SessionProvider(async () => ({
    accountId: "one",
    value: ++loads,
  }));
  let reads = 0;
  expect(
    await provider.run(signal(), false, async () => {
      if (++reads === 1) throw new SafeError("AUTH_REQUIRED");
      return "ok";
    }),
  ).toBe("ok");
  expect(loads).toBe(2);
  await expect(
    provider.run(signal(), false, async () => {
      throw new SafeError("AUTH_REQUIRED");
    }),
  ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  expect(loads).toBe(3);
  await expect(
    provider.run(signal(), false, async () => {
      throw new SafeError("PLAYLIST_UNAVAILABLE");
    }),
  ).rejects.toMatchObject({ code: "PLAYLIST_UNAVAILABLE" });
  // The final auth failure invalidated that snapshot; no retry on playlist denial.
  expect(loads).toBe(4);
});

test("continuation auth failures refresh identity but never replay the page", async () => {
  let loads = 0;
  const provider = new SessionProvider(async () => ({
    accountId: "one",
    value: ++loads,
  }));
  let reads = 0;
  await expect(
    provider.run(signal(), true, async () => {
      reads++;
      throw new SafeError("AUTH_REQUIRED");
    }),
  ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  expect(loads).toBe(2);
  expect(reads).toBe(1);
});

test("cancelled acquisition closes CDP; one cancelled waiter cannot cancel others", async () => {
  const f = cdpFixture({ stall: true });
  const provider = new SessionProvider(async (s) => ({
    accountId: "one",
    value: await acquireCookies(f.url, s),
  }));
  const a = new AbortController(),
    b = new AbortController();
  const first = provider.get(a.signal).catch(() => null);
  const second = provider.get(b.signal).catch(() => null);
  try {
    await Bun.sleep(20);
    a.abort();
    await first;
    expect(f.connections).toBe(1);
    b.abort();
    await second;
    await Bun.sleep(10);
    expect(f.connections).toBe(0);
    expect(f.discoveries).toBe(1);
  } finally {
    a.abort();
    b.abort();
    f.close();
  }
});
