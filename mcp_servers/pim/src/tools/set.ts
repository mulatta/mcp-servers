import { z } from "zod";
import { SafeError, type ErrorCode } from "../errors.ts";
import { expect } from "./schema.ts";

// RFC 8620 5.3 and the object specifications: a SetError means that one
// object was not changed.
const setErrors: Record<string, ErrorCode> = {
  notFound: "NOT_FOUND",
  mailboxHasEmail: "MAILBOX_NOT_EMPTY",
  mailboxHasChild: "MAILBOX_NOT_EMPTY",
  invalidProperties: "INVALID_REQUEST",
  invalidPatch: "INVALID_REQUEST",
  tooLarge: "INVALID_REQUEST",
  blobNotFound: "INVALID_REQUEST",
  invalidScript: "INVALID_REQUEST",
  invalidSieve: "INVALID_REQUEST",
  invalidEmail: "INVALID_REQUEST",
  alreadyExists: "INVALID_REQUEST",
  tooManyRecipients: "INVALID_REQUEST",
  noRecipients: "INVALID_REQUEST",
  invalidRecipients: "INVALID_REQUEST",
};
const setErrorCode = (error: unknown): ErrorCode => {
  const type = (error as { type?: unknown } | null)?.type;
  return (typeof type === "string" && setErrors[type]) || "WRITE_REJECTED";
};

const setResponse = z.object({
  created: z
    .record(z.string(), z.object({ id: z.string() }).loose())
    .nullable()
    .optional(),
  updated: z.record(z.string(), z.unknown()).nullable().optional(),
  destroyed: z.array(z.string()).nullable().optional(),
  notCreated: z.record(z.string(), z.unknown()).nullable().optional(),
  notUpdated: z.record(z.string(), z.unknown()).nullable().optional(),
  notDestroyed: z.record(z.string(), z.unknown()).nullable().optional(),
});

export interface Outcome {
  done: string[];
  failed: { id: string; code: ErrorCode }[];
}

/**
 * Which of `ids` a /set answer confirms for `kind`. An ID the answer neither
 * confirms nor refuses makes the whole outcome unknown, because the server
 * may have applied it. Nothing confirmed at all is the first refusal's error.
 */
export function outcome(
  answer: unknown,
  kind: "updated" | "destroyed",
  ids: string[],
): Outcome {
  const response = expect(setResponse, answer);
  const refused =
    kind === "updated" ? response.notUpdated : response.notDestroyed;
  const confirmed = new Set(
    kind === "updated"
      ? Object.keys(response.updated ?? {})
      : (response.destroyed ?? []),
  );
  const result: Outcome = { done: [], failed: [] };
  for (const id of ids) {
    if (confirmed.has(id)) result.done.push(id);
    else if (refused && id in refused)
      result.failed.push({ id, code: setErrorCode(refused[id]) });
    else throw new SafeError("WRITE_OUTCOME_UNKNOWN");
  }
  if (!result.done.length) throw new SafeError(result.failed[0]!.code);
  return result;
}

/** The server ID of the object created as `key`, or the refusal's error. */
export function created(answer: unknown, key: string): string {
  const response = expect(setResponse, answer);
  const made = response.created?.[key];
  if (made) return made.id;
  if (response.notCreated && key in response.notCreated)
    throw new SafeError(setErrorCode(response.notCreated[key]));
  throw new SafeError("WRITE_OUTCOME_UNKNOWN");
}

/** Like `outcome` for one object, as an error when it was refused. */
export function single(
  answer: unknown,
  kind: "updated" | "destroyed",
  id: string,
) {
  outcome(answer, kind, [id]);
}
