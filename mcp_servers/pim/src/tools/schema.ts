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

/** RFC 3339 date-time with any offset, sent as a JMAP UTCDate. */
export const utcDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString().replace(".000Z", "Z"));

/** The `list` of a /get answer; entries are parsed by the caller. */
export const getList = z.object({
  list: z.array(z.unknown()),
  notFound: z.array(z.string()).nullable().optional(),
});

/** Entry of a /get list with the given ID, or undefined. */
export function entry(list: unknown[], wanted: string): unknown {
  return list.find((item) => (item as { id?: unknown }).id === wanted);
}

/** Keys of a JMAP boolean map whose value is true, such as mailboxIds. */
export const trueKeys = (map: Record<string, boolean> | null | undefined) =>
  Object.keys(map ?? {}).filter((key) => map![key]);

export const queryPage = z.object({
  ids: z.array(z.string()),
  position: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
});
