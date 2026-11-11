import { z } from "zod";
import { SafeError } from "../errors.ts";

/** JMAP Id (RFC 8620 1.2). */
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

/** Parses a server answer, treating any other shape as an upstream change. */
export function expect<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SafeError("UPSTREAM_CHANGED");
  return parsed.data;
}
