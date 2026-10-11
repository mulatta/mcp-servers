import { SessionProvider, type Snapshot } from "./auth/session.ts";
import { SafeError } from "./errors.ts";
import type { ReadInput, ToolName } from "./server.ts";
import type { YoutubeClient } from "./youtube/client.ts";
import { resultEnvelope, type Item, type Result } from "./youtube/normalize.ts";

type State = {
  key: string;
  accountId: string;
  generation: number;
  created: number;
  buffer: Item[];
  continuation: string | null;
  result?: Result;
  pending?: Promise<Result>;
};

export class Paginator {
  private states = new Map<string, State>();
  private now: () => number;
  private maxStates: number;
  private maxBytes: number;
  constructor(
    private sessions: SessionProvider<YoutubeClient>,
    options: { now?: () => number; maxStates?: number; maxBytes?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxStates = options.maxStates ?? 128;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    sessions.onInvalidate(() => this.states.clear());
  }

  get usage() {
    let bytes = 0;
    for (const state of this.states.values())
      bytes += Buffer.byteLength(
        JSON.stringify([
          state.key,
          state.accountId,
          state.buffer,
          state.continuation,
          state.result ?? null,
        ]),
      );
    return { states: this.states.size, bytes };
  }

  private trim() {
    for (const [cursor, state] of this.states)
      if (this.now() >= state.created + 300_000) this.states.delete(cursor);
    while (
      this.states.size > this.maxStates ||
      this.usage.bytes > this.maxBytes
    ) {
      const oldest = this.states.keys().next().value;
      if (!oldest) break;
      this.states.delete(oldest);
    }
  }

  async read(
    name: ToolName,
    input: ReadInput,
    signal: AbortSignal,
  ): Promise<Result> {
    signal.throwIfAborted();
    this.trim();
    const key = JSON.stringify([name, input.playlist_id ?? null, input.limit]);
    let state: State | undefined;
    if (input.cursor) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          input.cursor,
        )
      )
        throw new SafeError("CURSOR_INVALID");
      state = this.states.get(input.cursor);
      if (!state) throw new SafeError("CURSOR_EXPIRED");
      if (state.key !== key) throw new SafeError("CURSOR_INVALID");
      this.states.delete(input.cursor);
      this.states.set(input.cursor, state);
    }
    return this.sessions.run(signal, !!input.cursor, async (snapshot) => {
      for (const [cursor, saved] of this.states)
        if (
          saved.generation !== snapshot.generation ||
          saved.accountId !== snapshot.accountId
        )
          this.states.delete(cursor);
      if (state) {
        if (
          state.generation !== snapshot.generation ||
          state.accountId !== snapshot.accountId ||
          this.states.get(input.cursor!) !== state ||
          this.now() >= state.created + 300_000
        )
          throw new SafeError("CURSOR_EXPIRED");
        if (state.result) return structuredClone(state.result);
        if (!state.pending) {
          state.pending = this.compute(
            name,
            input,
            key,
            snapshot,
            signal,
            state.buffer,
            state.continuation,
          )
            .then((result) => {
              state.result = result;
              state.buffer = [];
              state.continuation = null;
              delete state.pending;
              this.trim();
              return result;
            })
            .catch((error) => {
              this.states.delete(input.cursor!);
              throw error;
            });
        }
        return structuredClone(await state.pending);
      }
      const page = await snapshot.value.page(name, input, signal);
      return this.compute(
        name,
        input,
        key,
        snapshot,
        signal,
        page.items,
        page.continuation,
      );
    });
  }

  private async compute(
    name: ToolName,
    input: ReadInput,
    key: string,
    snapshot: Snapshot<YoutubeClient>,
    signal: AbortSignal,
    original: Item[],
    initialContinuation: string | null,
  ): Promise<Result> {
    let buffer = [...original],
      continuation = initialContinuation;
    // Avoid unbounded traversal through empty or filtered upstream pages.
    for (
      let extra = 0;
      buffer.length < input.limit && continuation && extra < 3;
      extra++
    ) {
      signal.throwIfAborted();
      if (!this.sessions.isCurrent(snapshot))
        throw new SafeError("CURSOR_EXPIRED");
      const page = await snapshot.value.page(name, input, signal, continuation);
      buffer.push(...page.items);
      continuation = page.continuation;
    }
    signal.throwIfAborted();
    if (!this.sessions.isCurrent(snapshot))
      throw new SafeError("CURSOR_EXPIRED");
    const items = buffer.slice(0, input.limit),
      rest = buffer.slice(input.limit);
    let cursor: string | null = null;
    if (rest.length || continuation) {
      cursor = crypto.randomUUID();
      this.states.set(cursor, {
        key,
        accountId: snapshot.accountId,
        generation: snapshot.generation,
        created: this.now(),
        buffer: rest,
        continuation,
      });
      this.trim();
      if (!this.states.has(cursor)) throw new SafeError("CURSOR_EXPIRED");
    }
    return resultEnvelope(snapshot.accountId, items, cursor);
  }
}
