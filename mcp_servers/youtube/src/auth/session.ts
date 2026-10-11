import { SafeError } from "../errors.ts";
import {
  stage,
  createRefresh,
  linkRefresh,
  recordCache,
  type RefreshTrace,
} from "../observability/trace.ts";

export type Snapshot<T> = {
  accountId: string;
  value: T;
  generation: number;
  expiresAt: number;
};
type Flight<T> = {
  controller: AbortController;
  promise: Promise<Snapshot<T>>;
  waiters: number;
  trace: RefreshTrace | undefined;
};

export class SessionProvider<T> {
  private snapshot: Snapshot<T> | undefined;
  private pinned: string | undefined;
  private changed = false;
  private generation = 0;
  private invalidationListeners = new Set<() => void>();
  private flight: Flight<T> | undefined;
  constructor(
    private load: (
      signal: AbortSignal,
    ) => Promise<{ accountId: string; value: T }>,
    private now = Date.now,
  ) {}

  assertAccountUnchanged() {
    if (this.changed) throw new SafeError("ACCOUNT_CHANGED");
  }

  isCurrent(snapshot: Snapshot<T>) {
    return (
      !this.changed &&
      this.snapshot === snapshot &&
      this.now() < snapshot.expiresAt
    );
  }

  onInvalidate(listener: () => void) {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  invalidate(snapshot?: Snapshot<T>) {
    if (!snapshot || this.snapshot === snapshot) {
      this.snapshot = undefined;
      for (const listener of this.invalidationListeners) listener();
    }
  }

  async get(signal: AbortSignal): Promise<Snapshot<T>> {
    return stage("auth.wait", () => this.acquire(signal));
  }

  private async acquire(signal: AbortSignal): Promise<Snapshot<T>> {
    signal.throwIfAborted();
    this.assertAccountUnchanged();
    if (this.snapshot && this.isCurrent(this.snapshot)) {
      recordCache("auth_cache", "hit");
      return this.snapshot;
    }
    recordCache("auth_cache", this.flight ? "shared" : "miss");
    this.invalidate();
    if (!this.flight) {
      const controller = new AbortController();
      const started = this.now();
      const flight: Flight<T> = {
        controller,
        waiters: 0,
        trace: createRefresh(),
        promise: Promise.resolve()
          .then(() => {
            const acquire = async () => {
              controller.signal.throwIfAborted();
              const loaded = await this.load(controller.signal);
              controller.signal.throwIfAborted();
              if (!loaded.accountId) throw new SafeError("AUTH_REQUIRED");
              if (this.pinned && this.pinned !== loaded.accountId) {
                this.changed = true;
                throw new SafeError("ACCOUNT_CHANGED");
              }
              if (this.now() >= started + 300_000)
                throw new SafeError("TIMEOUT");
              this.pinned = loaded.accountId;
              const snapshot = {
                ...loaded,
                generation: ++this.generation,
                expiresAt: started + 300_000,
              };
              this.snapshot = snapshot;
              return snapshot;
            };
            return flight.trace
              ? flight.trace.run(acquire, controller.signal)
              : acquire();
          })
          .finally(() => {
            if (this.flight === flight) this.flight = undefined;
          }),
      };
      this.flight = flight;
    }
    const flight = this.flight;
    const unlink = linkRefresh(flight.trace);
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        unlink();
        signal.removeEventListener("abort", abort);
        if (--flight.waiters === 0) {
          flight.controller.abort();
          if (this.flight === flight) this.flight = undefined;
        }
        return true;
      };
      const abort = () => {
        if (finish()) reject(new SafeError("UPSTREAM_UNAVAILABLE"));
      };
      signal.addEventListener("abort", abort, { once: true });
      flight.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }

  async run<R>(
    signal: AbortSignal,
    continuation: boolean,
    read: (snapshot: Snapshot<T>) => Promise<R>,
  ): Promise<R> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let snapshot: Snapshot<T> | undefined;
      try {
        snapshot = await this.get(signal);
        signal.throwIfAborted();
        const result = await read(snapshot);
        signal.throwIfAborted();
        if (this.changed) throw new SafeError("ACCOUNT_CHANGED");
        if (!this.isCurrent(snapshot)) throw new SafeError("CURSOR_EXPIRED");
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof SafeError) || error.code !== "AUTH_REQUIRED")
          throw error;
        this.invalidate(snapshot);
        if (attempt === 1) throw error;
        if (continuation) {
          await this.get(signal);
          throw new SafeError("CURSOR_EXPIRED");
        }
      }
    }
    throw new SafeError("AUTH_REQUIRED");
  }
}
