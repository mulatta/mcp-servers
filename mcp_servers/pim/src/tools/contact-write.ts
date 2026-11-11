import { z } from "zod";
import { tool } from "./define.ts";
import { id } from "./schema.ts";
import { created, single } from "./set.ts";

const fields = {
  name: z.string().min(1).max(1000),
  given_name: z.string().min(1).max(500),
  surname: z.string().min(1).max(500),
  emails: z.array(z.email().max(320)).max(20),
  phones: z.array(z.string().min(1).max(100)).max(20),
  organization: z.string().min(1).max(1000),
  note: z.string().min(1).max(100_000),
};

// JSContact (RFC 9553) maps keyed by short local IDs.
const numbered = <T>(
  prefix: string,
  values: T[],
  make: (value: T) => Record<string, unknown>,
) =>
  values.length
    ? Object.fromEntries(
        values.map((value, index) => [`${prefix}${index + 1}`, make(value)]),
      )
    : null;
const emails = (list: string[]) =>
  numbered("e", list, (address) => ({ "@type": "EmailAddress", address }));
const phones = (list: string[]) =>
  numbered("p", list, (number) => ({ "@type": "Phone", number }));
const organizations = (name: string | null) =>
  name ? { o1: { "@type": "Organization", name } } : null;
const notes = (note: string | null) =>
  note ? { n1: { "@type": "Note", note } } : null;

interface NameInput {
  name?: string | undefined;
  given_name?: string | undefined;
  surname?: string | undefined;
}
const hasName = (input: NameInput) =>
  input.name !== undefined ||
  input.given_name !== undefined ||
  input.surname !== undefined;

// Stalwart indexes name components for name and text search, not the full
// name, so given name and surname are stored as components.
function nameOf(input: NameInput) {
  const components = [
    ...(input.given_name
      ? [{ "@type": "NameComponent", kind: "given", value: input.given_name }]
      : []),
    ...(input.surname
      ? [{ "@type": "NameComponent", kind: "surname", value: input.surname }]
      : []),
  ];
  return {
    full: input.name ?? components.map((part) => part.value).join(" "),
    ...(components.length ? { components } : {}),
  };
}

const nameNote =
  "Name search finds given_name and surname words; a contact with only a display name is found by its emails, organization and other fields.";

export const createContact = tool({
  name: "pim_create_contact",
  group: "contact",
  description: `Create a contact card in an address book with a name (display name and/or given_name and surname) and optional emails, phones, organization and note. ${nameNote} Not idempotent: on WRITE_OUTCOME_UNKNOWN, search contacts before retrying.`,
  input: {
    address_book_id: id,
    name: fields.name.optional(),
    given_name: fields.given_name.optional(),
    surname: fields.surname.optional(),
    emails: fields.emails.default([]),
    phones: fields.phones.default([]),
    organization: fields.organization.optional(),
    note: fields.note.optional(),
  },
  check: hasName,
  async run(input, { jmap, signal, attempt }) {
    const uid = `urn:uuid:${crypto.randomUUID()}`;
    const card = Object.fromEntries(
      Object.entries({
        "@type": "Card",
        version: "1.0",
        uid,
        kind: "individual",
        addressBookIds: { [input.address_book_id]: true },
        name: nameOf(input),
        emails: emails(input.emails),
        phones: phones(input.phones),
        organizations: organizations(input.organization ?? null),
        notes: notes(input.note ?? null),
      }).filter(([, value]) => value !== null),
    );
    const [result] = await jmap.call(
      ["contacts"],
      [["ContactCard/set", { create: { new: card } }]],
      signal,
      {
        attempt,
      },
    );
    return { contact_id: created(result, "new"), uid };
  },
});

export const updateContact = tool({
  name: "pim_update_contact",
  group: "contact",
  description: `Replace fields of a contact: each given field replaces the whole field (emails replaces all addresses; an empty list or null clears it), and any of name, given_name or surname replaces the whole name. Other fields of the card stay as they are. ${nameNote}`,
  input: {
    contact_id: id,
    name: fields.name.optional(),
    given_name: fields.given_name.optional(),
    surname: fields.surname.optional(),
    emails: fields.emails.optional(),
    phones: fields.phones.optional(),
    organization: fields.organization.nullable().optional(),
    note: fields.note.nullable().optional(),
  },
  check: (input) =>
    Object.entries(input).some(
      ([key, value]) => key !== "contact_id" && value !== undefined,
    ),
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const patch: Record<string, unknown> = {};
    if (hasName(input)) patch.name = nameOf(input);
    if (input.emails !== undefined) patch.emails = emails(input.emails);
    if (input.phones !== undefined) patch.phones = phones(input.phones);
    if (input.organization !== undefined)
      patch.organizations = organizations(input.organization);
    if (input.note !== undefined) patch.notes = notes(input.note);
    const [result] = await jmap.call(
      ["contacts"],
      [["ContactCard/set", { update: { [input.contact_id]: patch } }]],
      signal,
      { attempt },
    );
    single(result, "updated", input.contact_id);
    return { contact_id: input.contact_id };
  },
});

export const deleteContact = tool({
  name: "pim_delete_contact",
  group: "contact",
  description: "Delete a contact card permanently.",
  input: { contact_id: id },
  destructive: true,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const [result] = await jmap.call(
      ["contacts"],
      [["ContactCard/set", { destroy: [input.contact_id] }]],
      signal,
      {
        attempt,
      },
    );
    single(result, "destroyed", input.contact_id);
    return { deleted: input.contact_id };
  },
});
