import { z } from "zod";
import { SafeError } from "../errors.ts";
import { tool } from "./define.ts";
import { entry, expect, getList, id } from "./schema.ts";

const vacation = z.object({
  isEnabled: z.boolean(),
  fromDate: z.string().nullable(),
  toDate: z.string().nullable(),
  subject: z.string().nullable(),
  textBody: z.string().nullable(),
});

export function vacationResult(value: unknown) {
  const response = expect(vacation, value);
  return {
    enabled: response.isEnabled,
    from_date: response.fromDate,
    to_date: response.toDate,
    subject: response.subject,
    text_body: response.textBody,
  };
}

export const getVacation = tool({
  name: "pim_get_vacation",
  description:
    "Read the vacation (out-of-office) auto-reply: whether it is on, its date range, subject and text.",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["vacation"],
      [["VacationResponse/get", { ids: ["singleton"] }]],
      signal,
    );
    const found = entry(expect(getList, result).list, "singleton");
    if (!found) throw new SafeError("UPSTREAM_CHANGED");
    return vacationResult(found);
  },
});

const script = z.object({
  id: z.string(),
  name: z.string().nullable(),
  isActive: z.boolean(),
  blobId: z.string(),
});

export const listSieveScripts = tool({
  name: "pim_list_sieve_scripts",
  description:
    "List the account's Sieve filter scripts and which one is active (at most one is).",
  input: {},
  async run(_input, { jmap, signal }) {
    const [result] = await jmap.call(
      ["sieve"],
      [["SieveScript/get", { ids: null }]],
      signal,
    );
    return {
      items: expect(z.object({ list: z.array(script) }), result).list.map(
        (entry) => ({
          script_id: entry.id,
          name: entry.name,
          active: entry.isActive,
        }),
      ),
    };
  },
});

const blob = z.object({ id: z.string(), "data:asText": z.string().nullable() });

export const getSieveScript = tool({
  name: "pim_get_sieve_script",
  description: "Read one Sieve filter script by ID, including its source text.",
  input: { script_id: id },
  async run(input, { jmap, signal }) {
    const [scripts, blobs] = await jmap.call(
      ["sieve", "blob"],
      [
        ["SieveScript/get", { ids: [input.script_id] }],
        [
          "Blob/get",
          {
            "#ids": {
              resultOf: "c0",
              name: "SieveScript/get",
              path: "/list/*/blobId",
            },
            properties: ["data:asText"],
          },
        ],
      ],
      signal,
    );
    const found = entry(expect(getList, scripts).list, input.script_id);
    if (!found) throw new SafeError("NOT_FOUND");
    const parsed = expect(script, found);
    const content = entry(expect(getList, blobs).list, parsed.blobId);
    if (!content) throw new SafeError("UPSTREAM_CHANGED");
    const text = expect(blob, content)["data:asText"];
    // Stalwart answers null when the script is not valid UTF-8.
    if (text === null) throw new SafeError("UPSTREAM_CHANGED");
    return {
      script_id: parsed.id,
      name: parsed.name,
      active: parsed.isActive,
      content: text,
    };
  },
});
