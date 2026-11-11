import { describe, expect, test } from "bun:test";
import { type AccountState, waitForAccount } from "../live/login.ts";

const ready = "UC" + "t".repeat(22);

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}

function probes(states: (AccountState | Error)[]) {
  let index = 0;
  return async () => {
    const state = states[Math.min(index++, states.length - 1)]!;
    if (state instanceof Error) throw state;
    return state;
  };
}

describe("waiting for the test account", () => {
  test("returns the account once ready, reporting each new state once", async () => {
    const seen: string[] = [];
    const account = await waitForAccount(
      probes([
        { state: "signed-out" },
        { state: "signed-out" },
        { state: "no-channel" },
        { state: "no-channel" },
        { state: "ready", accountId: ready },
      ]),
      {
        timeoutMs: 60_000,
        intervalMs: 5000,
        onState: (state) => seen.push(state.state),
        ...clock(),
      },
    );
    expect(account).toBe(ready);
    expect(seen).toEqual(["signed-out", "no-channel", "ready"]);
  });

  test("keeps waiting while the personal account is signed in", async () => {
    const seen: string[] = [];
    const account = await waitForAccount(
      probes([
        { state: "personal" },
        { state: "signed-out" },
        { state: "ready", accountId: ready },
      ]),
      {
        timeoutMs: 60_000,
        intervalMs: 5000,
        onState: (state) => seen.push(state.state),
        ...clock(),
      },
    );
    expect(account).toBe(ready);
    expect(seen).toEqual(["personal", "signed-out", "ready"]);
  });

  test("gives up after the timeout", async () => {
    const time = clock();
    const account = await waitForAccount(probes([{ state: "signed-out" }]), {
      timeoutMs: 600_000,
      intervalMs: 5000,
      onState: () => {},
      ...time,
    });
    expect(account).toBeUndefined();
    expect(time.now()).toBeGreaterThanOrEqual(600_000);
    expect(time.now()).toBeLessThan(610_000);
  });

  test("a failing probe counts as an error state and waiting goes on", async () => {
    const seen: string[] = [];
    const account = await waitForAccount(
      probes([new Error("boom"), { state: "ready", accountId: ready }]),
      {
        timeoutMs: 60_000,
        intervalMs: 5000,
        onState: (state) =>
          seen.push(
            state.state === "error" ? `error:${state.code}` : state.state,
          ),
        ...clock(),
      },
    );
    expect(account).toBe(ready);
    // The message is not echoed: it may carry upstream text.
    expect(seen).toEqual(["error:PROBE_FAILED", "ready"]);
  });
});
