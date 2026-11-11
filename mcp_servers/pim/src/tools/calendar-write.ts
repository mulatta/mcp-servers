import { z } from "zod";
import { SafeError } from "../errors.ts";
import type { Jmap } from "../jmap/client.ts";
import { tool } from "./define.ts";
import { entry, expect, getList, id } from "./schema.ts";
import { created, single } from "./set.ts";

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "YYYY-MM-DDTHH:MM:SS");
const duration = z
  .string()
  .regex(/^P(?:\d+W|(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/)
  .refine((value) => value !== "P", "empty duration");
const timeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "unknown IANA time zone");
const text = z.string().max(100_000);

// All-day events float: they start at midnight wherever the reader is and
// last whole days.
const wholeDays = (input: {
  start?: string | undefined;
  duration?: string | undefined;
}) =>
  (input.start === undefined || input.start.endsWith("T00:00:00")) &&
  (input.duration === undefined || !input.duration.includes("T"));

const locations = (name: string | null | undefined) =>
  name ? { l1: { "@type": "Location", name } } : null;

const scheduling =
  "Events with participants are never written (PARTICIPANTS_REFUSED), because saving them would send invitations; nor is a single occurrence of a recurring event.";

export const createEvent = tool({
  name: "pim_create_event",
  group: "calendar",
  description: `Create a calendar event without participants. start is local time (YYYY-MM-DDTHH:MM:SS) in time_zone (IANA, required unless all_day); duration is ISO 8601 (PT1H, P1D). all_day events start at T00:00:00 and last whole days. Not idempotent: on WRITE_OUTCOME_UNKNOWN, search the time range before retrying. ${scheduling}`,
  input: {
    calendar_id: id,
    title: z.string().min(1).max(1000),
    start: localDateTime,
    duration,
    time_zone: timeZone.optional(),
    all_day: z.boolean().default(false),
    description: text.optional(),
    location: z.string().min(1).max(1000).optional(),
  },
  check: (input) =>
    input.all_day ? wholeDays(input) && !input.time_zone : !!input.time_zone,
  async run(input, { jmap, signal, attempt }) {
    const uid = crypto.randomUUID();
    const event = {
      "@type": "Event",
      uid,
      calendarIds: { [input.calendar_id]: true },
      title: input.title,
      start: input.start,
      timeZone: input.all_day ? null : input.time_zone,
      duration: input.duration,
      showWithoutTime: input.all_day,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.location ? { locations: locations(input.location) } : {}),
    };
    const [result] = await jmap.call(
      ["calendars"],
      [
        [
          "CalendarEvent/set",
          { create: { new: event }, sendSchedulingMessages: false },
        ],
      ],
      signal,
      { attempt },
    );
    return { event_id: created(result, "new"), uid };
  },
});

const scheduled = z.object({
  id: z.string(),
  baseEventId: z.string().nullable().optional(),
  participants: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Refuses events that would send scheduling messages, and occurrences. */
async function requireUnscheduled(
  jmap: Jmap,
  signal: AbortSignal,
  eventId: string,
) {
  const [result] = await jmap.call(
    ["calendars"],
    [
      [
        "CalendarEvent/get",
        { ids: [eventId], properties: ["baseEventId", "participants"] },
      ],
    ],
    signal,
  );
  const found = entry(expect(getList, result).list, eventId);
  if (!found) throw new SafeError("NOT_FOUND");
  const event = expect(scheduled, found);
  if (Object.keys(event.participants ?? {}).length)
    throw new SafeError("PARTICIPANTS_REFUSED");
  if (event.baseEventId) throw new SafeError("INVALID_REQUEST");
}

export const updateEvent = tool({
  name: "pim_update_event",
  group: "calendar",
  description: `Change fields of a calendar event; only the given fields change, and null clears description or location. calendar_id moves it to another calendar. ${scheduling}`,
  input: {
    event_id: id,
    calendar_id: id.optional(),
    title: z.string().min(1).max(1000).optional(),
    start: localDateTime.optional(),
    duration: duration.optional(),
    time_zone: timeZone.nullable().optional(),
    all_day: z.boolean().optional(),
    description: text.nullable().optional(),
    location: z.string().min(1).max(1000).nullable().optional(),
  },
  check: (input) =>
    Object.entries(input).some(
      ([key, value]) => key !== "event_id" && value !== undefined,
    ) &&
    (input.all_day !== true || wholeDays(input)),
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    await requireUnscheduled(jmap, signal, input.event_id);
    const patch: Record<string, unknown> = {};
    if (input.calendar_id !== undefined)
      patch.calendarIds = { [input.calendar_id]: true };
    if (input.title !== undefined) patch.title = input.title;
    if (input.start !== undefined) patch.start = input.start;
    if (input.duration !== undefined) patch.duration = input.duration;
    if (input.time_zone !== undefined) patch.timeZone = input.time_zone;
    if (input.all_day !== undefined) {
      patch.showWithoutTime = input.all_day;
      if (input.all_day) patch.timeZone = null;
    }
    if (input.description !== undefined) patch.description = input.description;
    if (input.location !== undefined)
      patch.locations = locations(input.location);
    const [result] = await jmap.call(
      ["calendars"],
      [
        [
          "CalendarEvent/set",
          {
            update: { [input.event_id]: patch },
            sendSchedulingMessages: false,
          },
        ],
      ],
      signal,
      { attempt },
    );
    single(result, "updated", input.event_id);
    return { event_id: input.event_id };
  },
});

export const deleteEvent = tool({
  name: "pim_delete_event",
  group: "calendar",
  description: `Delete a calendar event, including every occurrence if it recurs. ${scheduling}`,
  input: { event_id: id },
  destructive: true,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    await requireUnscheduled(jmap, signal, input.event_id);
    const [result] = await jmap.call(
      ["calendars"],
      [
        [
          "CalendarEvent/set",
          { destroy: [input.event_id], sendSchedulingMessages: false },
        ],
      ],
      signal,
      { attempt },
    );
    single(result, "destroyed", input.event_id);
    return { deleted: input.event_id };
  },
});
