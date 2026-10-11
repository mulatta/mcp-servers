import { expect, test } from "bun:test";
import { SessionProvider } from "../../src/auth/session.ts";
import { acquireCookies } from "../../src/auth/cdp.ts";
import { withRequest } from "../../src/observability/trace.ts";
import { withDeadline } from "../../src/deadline.ts";
import { SafeError } from "../../src/errors.ts";
import { cdpFixture } from "../fixtures/cdp.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(2);
  expect(check()).toBe(true);
}

test("one cancelled CDP waiter leaves shared authentication and warm reuse correctly attributed", async () => {
  const f = cdpFixture({ delayMs: 10 });
  const c = captureDiagnostics();
  const sessions = new SessionProvider(async (signal) => ({
    accountId: "private-account",
    value: await acquireCookies(f.url, signal),
  }));
  const call = (parent: AbortSignal, limit: number) =>
    withRequest(c.logger, "youtube_get_watch_later", limit, () =>
      withDeadline(parent, 1000, async (signal) => {
        await sessions.get(signal);
        return { items: [] };
      }),
    );
  const a = new AbortController(),
    b = new AbortController();
  try {
    const first = call(a.signal, 1).catch(() => null);
    const second = call(b.signal, 2);
    await until(() => f.commands.length > 0);
    a.abort();
    await first;
    expect(f.connections).toBe(1);
    await second;
    await call(b.signal, 3);
    expect(f.discoveries).toBe(1);
    const records = await c.finish();
    const summaries = records.filter((r) => r.event === "request.end");
    expect(summaries.map((r) => r.outcome)).toEqual(["cancelled", "ok", "ok"]);
    expect(summaries.map((r) => r.auth_cache)).toEqual([
      "miss",
      "shared",
      "hit",
    ]);
    expect(
      summaries[0].active_stages.some(
        (r: { stage: string }) => r.stage === "cdp.cookies",
      ),
    ).toBe(true);
    const refresh = records.filter(
      (r) => r.event === "stage.end" && r.stage === "auth.refresh",
    );
    expect(refresh).toHaveLength(1);
    expect(refresh[0].outcome).toBe("ok");
    expect(refresh[0].request_id).toBeUndefined();
    const waits = records.filter(
      (r) => r.event === "stage.end" && r.stage === "auth.wait" && r.refresh_id,
    );
    expect(waits).toHaveLength(2);
    expect(waits.every((r) => r.refresh_id === refresh[0].refresh_id)).toBe(
      true,
    );
    expect(JSON.stringify(records)).not.toContain("private-account");
    expect(JSON.stringify(records)).not.toContain("fixture-secret");
  } finally {
    a.abort();
    b.abort();
    f.close();
  }
});

test("last waiter cancellation closes shared CDP stages without late successes", async () => {
  const f = cdpFixture({ stall: true });
  const c = captureDiagnostics();
  const sessions = new SessionProvider(async (signal) => ({
    accountId: "private-account",
    value: await acquireCookies(f.url, signal),
  }));
  const parent = new AbortController();
  try {
    const pending = withRequest(c.logger, "youtube_get_watch_later", 1, () =>
      withDeadline(parent.signal, 1000, async (signal) => {
        await sessions.get(signal);
        return { items: [] };
      }),
    ).catch(() => null);
    await until(() => f.commands.length > 0);
    parent.abort();
    await pending;
    await until(() => f.connections === 0);
    const records = await c.finish();
    const refresh = records.filter(
      (r) => r.event === "stage.end" && r.stage === "auth.refresh",
    );
    expect(refresh).toHaveLength(1);
    expect(refresh[0].outcome).toBe("cancelled");
    expect(records.filter((r) => r.event === "request.end")).toHaveLength(1);
  } finally {
    parent.abort();
    f.close();
  }
});

test("CDP failures, auth retry and account locks retain safe trace results", async () => {
  const f = cdpFixture();
  const c = captureDiagnostics();
  let accountId = "private-first-account";
  const sessions = new SessionProvider(async (signal) => ({
    accountId,
    value: await acquireCookies(f.url, signal),
  }));
  const signal = new AbortController().signal;
  const call = (operation: () => Promise<Record<string, unknown>>) =>
    withRequest(c.logger, "youtube_get_watch_later", 1, operation);
  try {
    await call(async () => {
      await sessions.get(signal);
      return { items: [] };
    });
    let attempts = 0;
    await call(() =>
      sessions.run(signal, false, async () => {
        if (++attempts === 1) throw new SafeError("AUTH_REQUIRED");
        return { items: [] };
      }),
    );
    expect(f.discoveries).toBe(2);
    accountId = "private-second-account";
    sessions.invalidate();
    await expect(
      call(async () => {
        await sessions.get(signal);
        return { items: [] };
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(f.discoveries).toBe(3);
    const broken = cdpFixture({ noPage: true });
    try {
      await expect(
        call(async () => {
          await acquireCookies(broken.url, signal);
          return {};
        }),
      ).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    } finally {
      broken.close();
    }
    const records = await c.finish();
    const summaries = records.filter((r) => r.event === "request.end");
    expect(summaries[1].auth_cache).toBe("mixed");
    expect(summaries[2].code).toBe("ACCOUNT_CHANGED");
    expect(summaries[3].code).toBe("BROWSER_UNAVAILABLE");
    expect(
      records.some(
        (r) => r.stage === "cdp.cookies" && r.code === "BROWSER_UNAVAILABLE",
      ),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private-");
  } finally {
    f.close();
  }
});
