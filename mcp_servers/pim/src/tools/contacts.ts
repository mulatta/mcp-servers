import { z } from "zod";
import { SafeError } from "../errors.ts";
import { decodeCursor, nextCursor } from "./cursor.ts";
import { tool } from "./define.ts";
import { entry, expect, getList, id, queryPage, trueKeys } from "./schema.ts";

const addressBook = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const listAddressBooks = tool({
  name: "pim_list_address_books",
  description:
    "List the account's address books with their IDs and which one is the default.",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["contacts"],
      [
        [
          "AddressBook/get",
          {
            ids: null,
            properties: ["name", "description", "isDefault", "sortOrder"],
          },
        ],
      ],
      signal,
    );
    return {
      items: expect(z.object({ list: z.array(addressBook) }), result)
        .list.toSorted((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((book) => ({
          address_book_id: book.id,
          name: book.name,
          description: book.description ?? null,
          is_default: book.isDefault ?? false,
        })),
    };
  },
});

const named = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .nullable()
  .optional();
const card = z.object({
  id: z.string(),
  addressBookIds: z.record(z.string(), z.boolean()).nullable().optional(),
  kind: z.string().nullable().optional(),
  name: z
    .object({
      full: z.string().nullable().optional(),
      components: z
        .array(z.object({ kind: z.string(), value: z.string() }))
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  emails: named,
  phones: named,
  organizations: named,
  notes: named,
});
const cardProperties = [
  "addressBookIds",
  "kind",
  "name",
  "emails",
  "phones",
  "organizations",
];

/** Values of one string field across a JSContact map such as emails. */
const values = (map: z.infer<typeof named>, field: string) =>
  Object.values(map ?? {}).flatMap((item) =>
    typeof item[field] === "string" ? [item[field] as string] : [],
  );

const order = [
  "title",
  "given",
  "given2",
  "surname",
  "surname2",
  "generation",
  "credential",
];

function displayName(name: z.infer<typeof card>["name"]) {
  if (name?.full) return name.full;
  const parts = (name?.components ?? []).toSorted(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  return parts.length ? parts.map((part) => part.value).join(" ") : null;
}

function summarizeCard(value: unknown) {
  const contact = expect(card, value);
  return {
    contact_id: contact.id,
    address_book_ids: trueKeys(contact.addressBookIds),
    kind: contact.kind ?? null,
    name: displayName(contact.name),
    emails: values(contact.emails, "address"),
    phones: values(contact.phones, "number"),
    organizations: values(contact.organizations, "name"),
  };
}

export const searchContacts = tool({
  name: "pim_search_contacts",
  description:
    "Search contacts. text matches whole words in names, nicknames, organizations, emails, phones, addresses and notes; email and name narrow further. Returns names, emails, phones and organizations; read a whole card with pim_get_contact.",
  input: {
    address_book_id: id.optional(),
    text: z.string().min(1).max(500).optional(),
    email: z.string().min(1).max(500).optional(),
    name: z.string().min(1).max(500).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(512).optional(),
  },
  async run(input, { jmap, signal }) {
    const position = decodeCursor("pim_search_contacts", input);
    const conditions: Record<string, unknown>[] = [];
    if (input.address_book_id)
      conditions.push({ inAddressBook: input.address_book_id });
    for (const key of ["text", "email", "name"] as const)
      if (input[key]) conditions.push({ [key]: input[key] });
    const [query, get] = await jmap.call(
      ["contacts"],
      [
        [
          "ContactCard/query",
          {
            // Stalwart rejects `filter: null`; no conditions means no filter at all.
            ...(conditions.length
              ? { filter: { operator: "AND", conditions } }
              : {}),
            position,
            limit: input.limit,
            calculateTotal: true,
          },
        ],
        [
          "ContactCard/get",
          {
            "#ids": { resultOf: "c0", name: "ContactCard/query", path: "/ids" },
            properties: cardProperties,
          },
        ],
      ],
      signal,
    );
    const page = expect(queryPage, query);
    const { list } = expect(getList, get);
    return {
      items: page.ids.flatMap((contactId) => {
        const found = entry(list, contactId);
        return found ? [summarizeCard(found)] : [];
      }),
      total: page.total ?? null,
      next_cursor: nextCursor(
        "pim_search_contacts",
        input,
        page.position,
        page.ids.length,
        page.total,
      ),
    };
  },
});

export const getContact = tool({
  name: "pim_get_contact",
  description:
    "Read one contact by ID: the summary fields, notes, and the whole JSContact card (RFC 9553) as `card`.",
  input: { contact_id: id },
  async run(input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["contacts"],
      [["ContactCard/get", { ids: [input.contact_id] }]],
      signal,
    );
    const found = entry(expect(getList, result).list, input.contact_id);
    if (!found) throw new SafeError("NOT_FOUND");
    const contact = expect(card, found);
    return {
      ...summarizeCard(found),
      notes: values(contact.notes, "note"),
      card: found,
    };
  },
});
