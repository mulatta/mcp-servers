import type { MethodCall } from "./stalwart.ts";

/** A JMAP handler answering each method with fixed arguments. */
export const answer =
  (byMethod: Record<string, Record<string, unknown>>) =>
  (calls: MethodCall[]) =>
    calls.map(([name, , id]): MethodCall => [name, byMethod[name] ?? {}, id]);
