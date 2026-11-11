import { createHash } from "node:crypto";
import { SafeError } from "../errors.ts";

// A cursor is the next position, bound to the tool and every other input so a
// cursor cannot be replayed against another search. It is not a snapshot:
// mail that arrives or moves between pages shifts positions.
function fingerprint(tool: string, input: Record<string, unknown>) {
  const { cursor: _cursor, ...rest } = input;
  const canonical = JSON.stringify(
    Object.keys(rest)
      .sort()
      .map((key) => [key, rest[key]]),
  );
  return createHash("sha256")
    .update(`${tool}\n${canonical}`)
    .digest("base64url")
    .slice(0, 16);
}

export function encodeCursor(
  tool: string,
  input: Record<string, unknown>,
  position: number,
) {
  return Buffer.from(
    JSON.stringify({ v: 1, h: fingerprint(tool, input), p: position }),
  ).toString("base64url");
}

export function decodeCursor(
  tool: string,
  input: Record<string, unknown>,
): number {
  const cursor = input.cursor;
  if (typeof cursor !== "string") return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      value?.v === 1 &&
      value.h === fingerprint(tool, input) &&
      Number.isSafeInteger(value.p) &&
      value.p >= 0
    )
      return value.p;
  } catch {
    // Falls through to the same refusal as a mismatched cursor.
  }
  throw new SafeError("CURSOR_INVALID");
}

/** The cursor for the page after this one, or null at the end. */
export function nextCursor(
  tool: string,
  input: Record<string, unknown>,
  position: number,
  returned: number,
  total: number | undefined,
) {
  const next = position + returned;
  return returned > 0 && total !== undefined && next < total
    ? encodeCursor(tool, input, next)
    : null;
}
