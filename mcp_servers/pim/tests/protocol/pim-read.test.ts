import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import { answer } from "../fixtures/answer.ts";

let env: Connected;
beforeEach(async () => {
  env = await connected();
});
afterEach(() => env.stop());
const sent = (index = 0) => env.stalwart.jmapRequests[index]!;

const event = {
  id: "ev1",
  baseEventId: null,
  calendarIds: { c1: true },
  title: "Dentist",
  start: "2026-11-12T09:30:00",
  timeZone: "Asia/Seoul",
  duration: "PT1H",
  showWithoutTime: false,
  utcStart: "2026-11-12T00:30:00Z",
  utcEnd: "2026-11-12T01:30:00Z",
  status: "confirmed",
  locations: { l1: { "@type": "Location", name: "Clinic" } },
  participants: null,
};

describe("calendars", () => {
  test("pim_list_calendars", async () => {
    env.stalwart.jmap = answer({
      "Calendar/get": {
        list: [
          {
            id: "c1",
            name: "Personal",
            description: null,
            color: "#3366ff",
            isDefault: true,
            isVisible: true,
            sortOrder: 0,
          },
        ],
      },
    });
    expect((await env.call("pim_list_calendars")).structured).toEqual({
      items: [
        {
          calendar_id: "c1",
          name: "Personal",
          description: null,
          color: "#3366ff",
          is_default: true,
        },
      ],
    });
    expect(sent().using).toContain("urn:ietf:params:jmap:calendars");
  });

  test("pim_search_events expands recurrences inside the range", async () => {
    env.stalwart.jmap = answer({
      "CalendarEvent/query": { ids: ["ev1"], position: 0, total: 1 },
      "CalendarEvent/get": { list: [event], notFound: [] },
    });
    const result = await env.call("pim_search_events", {
      after: "2026-11-10T00:00:00Z",
      before: "2026-11-17T00:00:00+09:00",
      calendar_id: "c1",
      text: "dent",
    });
    expect(result.structured).toEqual({
      items: [
        {
          event_id: "ev1",
          base_event_id: null,
          calendar_ids: ["c1"],
          title: "Dentist",
          start: "2026-11-12T09:30:00",
          time_zone: "Asia/Seoul",
          duration: "PT1H",
          all_day: false,
          utc_start: "2026-11-12T00:30:00Z",
          utc_end: "2026-11-12T01:30:00Z",
          status: "confirmed",
          locations: ["Clinic"],
          participant_count: 0,
        },
      ],
      total: 1,
      next_cursor: null,
    });
    const [, args] = sent().calls[0]!;
    expect(args).toMatchObject({
      filter: {
        operator: "AND",
        conditions: [
          { after: "2026-11-10T00:00:00Z" },
          { before: "2026-11-16T15:00:00Z" },
          { inCalendar: "c1" },
          { text: "dent" },
        ],
      },
      expandRecurrences: true,
      sort: [{ property: "start", isAscending: true }],
    });
  });

  test("pim_search_events refuses ranges over a year or backwards", async () => {
    for (const range of [
      { after: "2026-01-01T00:00:00Z", before: "2027-01-01T00:00:01Z" },
      { after: "2026-02-01T00:00:00Z", before: "2026-01-01T00:00:00Z" },
    ]) {
      const result = await env.client.callTool({
        name: "pim_search_events",
        arguments: range,
      });
      expect(result.isError).toBe(true);
    }
    expect(env.stalwart.jmapRequests).toHaveLength(0);
  });

  test("an event read directly is its own base, not an occurrence", async () => {
    env.stalwart.jmap = answer({
      "CalendarEvent/get": {
        notFound: [],
        list: [{ ...event, baseEventId: "ev1" }],
      },
    });
    expect(
      (await env.call("pim_get_event", { event_id: "ev1" })).structured!
        .base_event_id,
    ).toBeNull();
  });

  test("pim_get_event returns participants and description", async () => {
    env.stalwart.jmap = answer({
      "CalendarEvent/get": {
        notFound: [],
        list: [
          {
            ...event,
            uid: "uid-1",
            description: "Bring card",
            recurrenceRules: [
              { "@type": "RecurrenceRule", frequency: "weekly" },
            ],
            participants: {
              p1: {
                "@type": "Participant",
                name: "Friend",
                email: "friend@example.test",
                roles: { attendee: true },
                participationStatus: "accepted",
              },
            },
          },
        ],
      },
    });
    const result = await env.call("pim_get_event", { event_id: "ev1" });
    expect(result.structured).toMatchObject({
      event_id: "ev1",
      uid: "uid-1",
      description: "Bring card",
      recurrence_rules: [{ "@type": "RecurrenceRule", frequency: "weekly" }],
      participants: [
        {
          name: "Friend",
          email: "friend@example.test",
          roles: ["attendee"],
          participation_status: "accepted",
        },
      ],
      participant_count: 1,
    });
    env.stalwart.jmap = answer({
      "CalendarEvent/get": { list: [], notFound: ["x"] },
    });
    expect(
      (await env.call("pim_get_event", { event_id: "x" })).error?.code,
    ).toBe("NOT_FOUND");
  });
});

describe("contacts", () => {
  const card = {
    id: "k1",
    addressBookIds: { b1: true },
    kind: "individual",
    name: { full: "Ada Example" },
    emails: { e1: { address: "ada@example.test" } },
    phones: { p1: { number: "+82 10 0000 0000" } },
    organizations: { o1: { name: "Example Org" } },
  };

  test("pim_list_address_books", async () => {
    env.stalwart.jmap = answer({
      "AddressBook/get": {
        list: [
          {
            id: "b1",
            name: "Contacts",
            description: null,
            isDefault: true,
            sortOrder: 0,
          },
        ],
      },
    });
    expect((await env.call("pim_list_address_books")).structured).toEqual({
      items: [
        {
          address_book_id: "b1",
          name: "Contacts",
          description: null,
          is_default: true,
        },
      ],
    });
  });

  test("pim_search_contacts", async () => {
    env.stalwart.jmap = answer({
      "ContactCard/query": { ids: ["k1"], position: 0, total: 1 },
      "ContactCard/get": { list: [card], notFound: [] },
    });
    const result = await env.call("pim_search_contacts", {
      text: "ada",
      address_book_id: "b1",
    });
    expect(result.structured).toEqual({
      items: [
        {
          contact_id: "k1",
          address_book_ids: ["b1"],
          kind: "individual",
          name: "Ada Example",
          emails: ["ada@example.test"],
          phones: ["+82 10 0000 0000"],
          organizations: ["Example Org"],
        },
      ],
      total: 1,
      next_cursor: null,
    });
    expect(sent().calls[0]![1].filter).toEqual({
      operator: "AND",
      conditions: [{ inAddressBook: "b1" }, { text: "ada" }],
    });
    expect(sent().using).toContain("urn:ietf:params:jmap:contacts");
  });

  test("a search without conditions sends no filter", async () => {
    // Stalwart rejects `filter: null` with invalidArguments.
    env.stalwart.jmap = answer({
      "ContactCard/query": { ids: [], position: 0, total: 0 },
      "ContactCard/get": { list: [], notFound: [] },
    });
    await env.call("pim_search_contacts", {});
    expect("filter" in sent().calls[0]![1]).toBe(false);
  });

  test("names fall back to their components", async () => {
    env.stalwart.jmap = answer({
      "ContactCard/get": {
        notFound: [],
        list: [
          {
            ...card,
            name: {
              components: [
                { kind: "given", value: "Ada" },
                { kind: "surname", value: "Example" },
              ],
            },
            notes: { n1: { note: "Met at a conference" } },
          },
        ],
      },
    });
    const result = await env.call("pim_get_contact", { contact_id: "k1" });
    expect(result.structured).toMatchObject({
      name: "Ada Example",
      notes: ["Met at a conference"],
    });
    expect(result.structured!.card).toMatchObject({ id: "k1" });
  });
});

describe("account settings", () => {
  test("pim_get_vacation", async () => {
    env.stalwart.jmap = answer({
      "VacationResponse/get": {
        list: [
          {
            id: "singleton",
            isEnabled: true,
            fromDate: null,
            toDate: "2026-11-20T00:00:00Z",
            subject: "Away",
            textBody: "Back soon",
            htmlBody: null,
          },
        ],
      },
    });
    expect((await env.call("pim_get_vacation")).structured).toEqual({
      enabled: true,
      from_date: null,
      to_date: "2026-11-20T00:00:00Z",
      subject: "Away",
      text_body: "Back soon",
    });
  });

  test("pim_get_vacation on an account that never set one", async () => {
    // Stalwart answers notFound until the first VacationResponse/set.
    env.stalwart.jmap = answer({
      "VacationResponse/get": { list: [], notFound: ["singleton"] },
    });
    expect((await env.call("pim_get_vacation")).structured).toEqual({
      enabled: false,
      from_date: null,
      to_date: null,
      subject: null,
      text_body: null,
    });
  });

  test("pim_list_sieve_scripts and pim_get_sieve_script", async () => {
    env.stalwart.jmap = answer({
      "SieveScript/get": {
        list: [{ id: "s1", name: "filters", isActive: true, blobId: "bs1" }],
        notFound: [],
      },
      "Blob/get": {
        list: [{ id: "bs1", "data:asText": 'require "fileinto";\n' }],
        notFound: [],
      },
    });
    expect((await env.call("pim_list_sieve_scripts")).structured).toEqual({
      items: [{ script_id: "s1", name: "filters", active: true }],
    });
    const script = await env.call("pim_get_sieve_script", { script_id: "s1" });
    expect(script.structured).toEqual({
      script_id: "s1",
      name: "filters",
      active: true,
      content: 'require "fileinto";\n',
    });
    const calls = sent(1).calls;
    expect(calls[1]![1]["#ids"]).toEqual({
      resultOf: "c0",
      name: "SieveScript/get",
      path: "/list/*/blobId",
    });
  });
});
