import { z } from "zod";
import { SafeError } from "../errors.ts";
import { decodeCursor, nextCursor } from "./cursor.ts";
import { tool } from "./define.ts";
import {
  entry,
  expect,
  getList,
  id,
  queryPage,
  trueKeys,
  utcDate,
} from "./schema.ts";

const calendar = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const listCalendars = tool({
  name: "pim_list_calendars",
  description:
    "List the account's calendars with their IDs, names, colours and which one is the default.",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["calendars"],
      [
        [
          "Calendar/get",
          {
            ids: null,
            properties: [
              "name",
              "description",
              "color",
              "isDefault",
              "sortOrder",
            ],
          },
        ],
      ],
      signal,
    );
    return {
      items: expect(z.object({ list: z.array(calendar) }), result)
        .list.toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((entry) => ({
          calendar_id: entry.id,
          name: entry.name,
          description: entry.description ?? null,
          color: entry.color ?? null,
          is_default: entry.isDefault ?? false,
        })),
    };
  },
});

const participant = z.object({
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  roles: z.record(z.string(), z.boolean()).nullable().optional(),
  participationStatus: z.string().nullable().optional(),
});
const eventSummary = z.object({
  id: z.string(),
  baseEventId: z.string().nullable().optional(),
  calendarIds: z.record(z.string(), z.boolean()).nullable(),
  title: z.string().nullable().optional(),
  start: z.string().nullable().optional(),
  timeZone: z.string().nullable().optional(),
  duration: z.string().nullable().optional(),
  showWithoutTime: z.boolean().nullable().optional(),
  utcStart: z.string().nullable().optional(),
  utcEnd: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  locations: z
    .record(z.string(), z.object({ name: z.string().nullable().optional() }))
    .nullable()
    .optional(),
  participants: z.record(z.string(), participant).nullable().optional(),
});
export const eventProperties = [
  "baseEventId",
  "calendarIds",
  "title",
  "start",
  "timeZone",
  "duration",
  "showWithoutTime",
  "utcStart",
  "utcEnd",
  "status",
  "locations",
  "participants",
];

function summarizeEvent(value: unknown) {
  const event = expect(eventSummary, value);
  return {
    event_id: event.id,
    // Stalwart names an event its own base when it is read directly.
    base_event_id:
      event.baseEventId && event.baseEventId !== event.id
        ? event.baseEventId
        : null,
    calendar_ids: trueKeys(event.calendarIds),
    title: event.title ?? null,
    start: event.start ?? null,
    time_zone: event.timeZone ?? null,
    duration: event.duration ?? null,
    all_day: event.showWithoutTime ?? false,
    utc_start: event.utcStart ?? null,
    utc_end: event.utcEnd ?? null,
    status: event.status ?? null,
    locations: Object.values(event.locations ?? {}).flatMap((place) =>
      place.name ? [place.name] : [],
    ),
    participant_count: Object.keys(event.participants ?? {}).length,
  };
}

// Stalwart's maxExpandedQueryDuration is P52W1D.
const yearMs = 365 * 24 * 60 * 60 * 1000;

export const searchEvents = tool({
  name: "pim_search_events",
  description:
    "List calendar events overlapping a time range (after and before, ISO 8601, at most 365 days apart), earliest first. Recurring events appear once per occurrence, each with its own event_id and the series in base_event_id. Optional calendar_id and text (title, description, location, people). Read details with pim_get_event.",
  input: {
    after: utcDate,
    before: utcDate,
    calendar_id: id.optional(),
    text: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  },
  check: (input) => {
    const span = Date.parse(input.before) - Date.parse(input.after);
    return span > 0 && span <= yearMs;
  },
  async run(input, { jmap, signal }) {
    const position = decodeCursor("pim_search_events", input);
    const conditions: Record<string, unknown>[] = [
      { after: input.after },
      { before: input.before },
    ];
    if (input.calendar_id) conditions.push({ inCalendar: input.calendar_id });
    if (input.text) conditions.push({ text: input.text });
    const [query, get] = await jmap.call(
      ["calendars"],
      [
        [
          "CalendarEvent/query",
          {
            filter: { operator: "AND", conditions },
            sort: [{ property: "start", isAscending: true }],
            expandRecurrences: true,
            position,
            limit: input.limit,
            calculateTotal: true,
          },
        ],
        [
          "CalendarEvent/get",
          {
            "#ids": {
              resultOf: "c0",
              name: "CalendarEvent/query",
              path: "/ids",
            },
            properties: eventProperties,
          },
        ],
      ],
      signal,
    );
    const page = expect(queryPage, query);
    const { list } = expect(getList, get);
    const items = page.ids.flatMap((eventId) => {
      const found = entry(list, eventId);
      return found ? [summarizeEvent(found)] : [];
    });
    return {
      items,
      total: page.total ?? null,
      next_cursor: nextCursor(
        "pim_search_events",
        input,
        page.position,
        page.ids.length,
        page.total,
      ),
    };
  },
});

const eventDetail = z.object({
  uid: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  recurrenceRules: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .optional(),
  participants: z.record(z.string(), participant).nullable().optional(),
});

export const getEvent = tool({
  name: "pim_get_event",
  description:
    "Read one calendar event by ID (an occurrence ID from pim_search_events also works): summary fields plus UID, description, recurrence rules and participants.",
  input: { event_id: id },
  async run(input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["calendars"],
      [
        [
          "CalendarEvent/get",
          {
            ids: [input.event_id],
            properties: [
              ...eventProperties,
              "uid",
              "description",
              "recurrenceRules",
            ],
          },
        ],
      ],
      signal,
    );
    const found = entry(expect(getList, result).list, input.event_id);
    if (!found) throw new SafeError("NOT_FOUND");
    const detail = expect(eventDetail, found);
    return {
      ...summarizeEvent(found),
      uid: detail.uid ?? null,
      description: detail.description ?? null,
      recurrence_rules: detail.recurrenceRules ?? [],
      participants: Object.values(detail.participants ?? {}).map((person) => ({
        name: person.name ?? null,
        email: person.email ?? null,
        roles: trueKeys(person.roles),
        participation_status: person.participationStatus ?? null,
      })),
    };
  },
});
