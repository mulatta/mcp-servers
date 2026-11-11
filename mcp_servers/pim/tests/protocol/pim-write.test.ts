import { afterEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import { answer } from "../fixtures/answer.ts";

let env: Connected;
afterEach(() => env.stop());
const methods = () =>
  env.stalwart.jmapRequests.flatMap((request) =>
    request.calls.map(([name]) => name),
  );
const setArgs = (method: string): Record<string, any> =>
  env.stalwart.jmapRequests
    .flatMap((request) => request.calls)
    .find(([name]) => name === method)![1];

const plain = { id: "ev1", baseEventId: null, participants: null };
const invited = {
  id: "ev2",
  baseEventId: null,
  participants: {
    p1: { "@type": "Participant", email: "friend@example.test" },
  },
};

describe("calendar", () => {
  test("creates a timed event without scheduling messages", async () => {
    env = await connected({ writes: ["calendar"] });
    env.stalwart.jmap = answer({
      "CalendarEvent/set": { created: { new: { id: "ev9" } } },
    });
    const result = await env.call("pim_create_event", {
      calendar_id: "c1",
      title: "Dentist",
      start: "2026-11-12T09:30:00",
      time_zone: "Asia/Seoul",
      duration: "PT1H",
      location: "Clinic",
      description: "Bring card",
    });
    expect(result.structured).toMatchObject({
      event_id: "ev9",
      uid: expect.any(String),
    });
    const args = setArgs("CalendarEvent/set");
    expect(args.sendSchedulingMessages).toBe(false);
    expect(args.create).toEqual({
      new: {
        "@type": "Event",
        uid: result.structured!.uid,
        calendarIds: { c1: true },
        title: "Dentist",
        start: "2026-11-12T09:30:00",
        timeZone: "Asia/Seoul",
        duration: "PT1H",
        showWithoutTime: false,
        description: "Bring card",
        locations: { l1: { "@type": "Location", name: "Clinic" } },
      },
    });
  });

  test("an all-day event is floating and needs a whole-day start", async () => {
    env = await connected({ writes: ["calendar"] });
    env.stalwart.jmap = answer({
      "CalendarEvent/set": { created: { new: { id: "ev9" } } },
    });
    await env.call("pim_create_event", {
      calendar_id: "c1",
      title: "Trip",
      start: "2026-11-20T00:00:00",
      duration: "P3D",
      all_day: true,
    });
    expect(setArgs("CalendarEvent/set").create.new).toMatchObject({
      showWithoutTime: true,
      timeZone: null,
      duration: "P3D",
    });
    const bad = await env.client.callTool({
      name: "pim_create_event",
      arguments: {
        calendar_id: "c1",
        title: "x",
        start: "2026-11-20T10:00:00",
        duration: "PT1H",
        all_day: true,
      },
    });
    expect(bad.isError).toBe(true);
  });

  test("updates and deletes only events without participants", async () => {
    env = await connected({ writes: ["calendar"] });
    env.stalwart.jmap = answer({
      "CalendarEvent/get": { list: [invited], notFound: [] },
      "CalendarEvent/set": { updated: { ev2: null } },
    });
    expect(
      (await env.call("pim_update_event", { event_id: "ev2", title: "Moved" }))
        .error?.code,
    ).toBe("PARTICIPANTS_REFUSED");
    expect(
      (await env.call("pim_delete_event", { event_id: "ev2" })).error?.code,
    ).toBe("PARTICIPANTS_REFUSED");
    expect(methods()).not.toContain("CalendarEvent/set");

    env.stalwart.jmap = answer({
      "CalendarEvent/get": { list: [plain], notFound: [] },
      "CalendarEvent/set": { updated: { ev1: null } },
    });
    expect(
      (
        await env.call("pim_update_event", {
          event_id: "ev1",
          title: "Moved",
          location: null,
        })
      ).structured,
    ).toEqual({
      event_id: "ev1",
    });
    expect(setArgs("CalendarEvent/set")).toMatchObject({
      update: { ev1: { title: "Moved", locations: null } },
      sendSchedulingMessages: false,
    });
  });

  test("a single occurrence of a recurring event is not changed", async () => {
    env = await connected({ writes: ["calendar"] });
    env.stalwart.jmap = answer({
      "CalendarEvent/get": {
        list: [{ ...plain, id: "occ", baseEventId: "ev1" }],
        notFound: [],
      },
    });
    expect(
      (await env.call("pim_delete_event", { event_id: "occ" })).error?.code,
    ).toBe("INVALID_REQUEST");
    expect(methods()).not.toContain("CalendarEvent/set");
  });

  test("participants cannot even be supplied", async () => {
    env = await connected({ writes: ["calendar"] });
    const result = await env.client.callTool({
      name: "pim_create_event",
      arguments: {
        calendar_id: "c1",
        title: "x",
        start: "2026-11-12T09:30:00",
        duration: "PT1H",
        participants: [],
      },
    });
    expect(result.isError).toBe(true);
  });
});

describe("contact", () => {
  test("creates a JSContact card", async () => {
    env = await connected({ writes: ["contact"] });
    env.stalwart.jmap = answer({
      "ContactCard/set": { created: { new: { id: "k9" } } },
    });
    const result = await env.call("pim_create_contact", {
      address_book_id: "b1",
      name: "Ada Example",
      emails: ["ada@example.test"],
      phones: ["+82 10 0000 0000"],
      organization: "Example Org",
      note: "Met at a conference",
    });
    expect(result.structured).toMatchObject({
      contact_id: "k9",
      uid: expect.any(String),
    });
    expect(setArgs("ContactCard/set").create.new).toEqual({
      "@type": "Card",
      version: "1.0",
      uid: result.structured!.uid,
      kind: "individual",
      addressBookIds: { b1: true },
      name: { full: "Ada Example" },
      emails: { e1: { "@type": "EmailAddress", address: "ada@example.test" } },
      phones: { p1: { "@type": "Phone", number: "+82 10 0000 0000" } },
      organizations: { o1: { "@type": "Organization", name: "Example Org" } },
      notes: { n1: { "@type": "Note", note: "Met at a conference" } },
    });
  });

  test("updates replace the given fields and deletes are confirmed", async () => {
    env = await connected({ writes: ["contact"] });
    env.stalwart.jmap = answer({
      "ContactCard/set": { updated: { k1: null }, destroyed: ["k1"] },
    });
    await env.call("pim_update_contact", {
      contact_id: "k1",
      emails: [],
      organization: null,
    });
    expect(setArgs("ContactCard/set").update).toEqual({
      k1: { emails: null, organizations: null },
    });
    expect(
      (await env.call("pim_delete_contact", { contact_id: "k1" })).structured,
    ).toEqual({ deleted: "k1" });
  });
});
