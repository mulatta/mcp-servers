import { z } from "zod";
import { SafeError } from "../errors.ts";
import { tool } from "./define.ts";
import { entry, expect, getList, id, utcDate } from "./schema.ts";
import { created, single } from "./set.ts";

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
    const answer = expect(getList, result);
    const found = entry(answer.list, "singleton");
    if (found) return vacationResult(found);
    // Stalwart has no singleton until the first VacationResponse/set; an
    // account that never set one has the reply off.
    if (answer.notFound?.includes("singleton"))
      return {
        enabled: false,
        from_date: null,
        to_date: null,
        subject: null,
        text_body: null,
      };
    throw new SafeError("UPSTREAM_CHANGED");
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

const scriptContent = z.string().min(1).max(1_000_000);

/** Uploads Sieve source as blob creation `#script` of the same request. */
const uploadScript = (content: string): [string, Record<string, unknown>] => [
  "Blob/upload",
  {
    create: {
      script: { data: [{ "data:asText": content }], type: "application/sieve" },
    },
  },
];

const uploadResult = z.object({
  created: z
    .record(z.string(), z.object({ id: z.string() }))
    .nullable()
    .optional(),
});

/** The blob ID of upload `#script`, or the server's refusal. */
function uploaded(answer: unknown) {
  const blob = expect(uploadResult, answer).created?.script;
  if (!blob) throw new SafeError("INVALID_REQUEST");
  return blob.id;
}

const validation = z.object({
  error: z
    .object({ type: z.string(), description: z.string().nullable().optional() })
    .nullable(),
});

export const validateSieveScript = tool({
  name: "pim_validate_sieve_script",
  group: "sieve",
  description:
    "Check Sieve source with the server's own parser without saving it. Returns valid and the server's error message.",
  input: { content: scriptContent },
  idempotent: true,
  async run(input, { jmap, signal }) {
    // Uploading a blob changes no visible state, so this is not a tracked
    // write. Stalwart 0.15 resolves blob creation IDs in SieveScript/set but
    // not in SieveScript/validate, so the upload is its own request.
    const [upload] = await jmap.call(
      ["blob"],
      [uploadScript(input.content)],
      signal,
    );
    const [result] = await jmap.call(
      ["sieve"],
      [["SieveScript/validate", { blobId: uploaded(upload) }]],
      signal,
    );
    const { error } = expect(validation, result);
    return {
      valid: error === null,
      error: error ? (error.description ?? error.type) : null,
    };
  },
});

export const saveSieveScript = tool({
  name: "pim_save_sieve_script",
  group: "sieve",
  description:
    "Create a Sieve filter script, or replace the name and source of script_id. The server refuses invalid source with INVALID_REQUEST (check first with pim_validate_sieve_script). activate: true also makes it the one active script, which immediately changes how incoming mail is filed.",
  input: {
    script_id: id.optional(),
    name: z.string().min(1).max(255),
    content: scriptContent,
    activate: z.boolean().default(false),
  },
  async run(input, { jmap, signal, attempt }) {
    const fields = { name: input.name, blobId: "#script" };
    const target = input.script_id ?? "#new";
    const [, result] = await jmap.call(
      ["sieve", "blob"],
      [
        uploadScript(input.content),
        [
          "SieveScript/set",
          {
            ...(input.script_id
              ? { update: { [input.script_id]: fields } }
              : { create: { new: fields } }),
            ...(input.activate ? { onSuccessActivateScript: target } : {}),
          },
        ],
      ],
      signal,
      { attempt },
    );
    let scriptId = input.script_id;
    if (scriptId) single(result, "updated", scriptId);
    else scriptId = created(result, "new");
    return { script_id: scriptId, name: input.name, activated: input.activate };
  },
});

export const activateSieveScript = tool({
  name: "pim_activate_sieve_script",
  group: "sieve",
  description:
    "Make script_id the one active Sieve script, or pass null to deactivate filtering. Takes effect for the next incoming mail.",
  input: { script_id: id.nullable() },
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const [, scripts] = await jmap.call(
      ["sieve"],
      [
        [
          "SieveScript/set",
          input.script_id === null
            ? { onSuccessDeactivateScript: true }
            : { onSuccessActivateScript: input.script_id },
        ],
        [
          "SieveScript/get",
          { ids: null, properties: ["name", "isActive", "blobId"] },
        ],
      ],
      signal,
      { attempt },
    );
    // The set answer does not report activation, so the read in the same
    // request is the confirmation.
    const active = expect(
      z.object({ list: z.array(script) }),
      scripts,
    ).list.filter((entry) => entry.isActive);
    const confirmed =
      input.script_id === null
        ? active.length === 0
        : active.length === 1 && active[0]!.id === input.script_id;
    if (!confirmed) throw new SafeError("WRITE_OUTCOME_UNKNOWN");
    return { active_script_id: input.script_id };
  },
});

export const deleteSieveScript = tool({
  name: "pim_delete_sieve_script",
  group: "sieve",
  description:
    "Delete a Sieve script. The active script cannot be deleted (WRITE_REJECTED); deactivate it first with pim_activate_sieve_script.",
  input: { script_id: id },
  destructive: true,
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const [result] = await jmap.call(
      ["sieve"],
      [["SieveScript/set", { destroy: [input.script_id] }]],
      signal,
      {
        attempt,
      },
    );
    single(result, "destroyed", input.script_id);
    return { deleted: input.script_id };
  },
});

export const setVacation = tool({
  name: "pim_set_vacation",
  group: "vacation",
  description:
    "Turn the vacation auto-reply on or off and change its dates (ISO 8601, null for open-ended), subject and text. Only the given fields change. While on, senders get the reply automatically.",
  input: {
    enabled: z.boolean().optional(),
    from_date: utcDate.nullable().optional(),
    to_date: utcDate.nullable().optional(),
    subject: z.string().max(998).nullable().optional(),
    text_body: z.string().max(100_000).nullable().optional(),
  },
  check: (input) => Object.values(input).some((value) => value !== undefined),
  idempotent: true,
  async run(input, { jmap, signal, attempt }) {
    const patch: Record<string, unknown> = {};
    if (input.enabled !== undefined) patch.isEnabled = input.enabled;
    if (input.from_date !== undefined) patch.fromDate = input.from_date;
    if (input.to_date !== undefined) patch.toDate = input.to_date;
    if (input.subject !== undefined) patch.subject = input.subject;
    if (input.text_body !== undefined) patch.textBody = input.text_body;
    const [result, current] = await jmap.call(
      ["vacation"],
      [
        ["VacationResponse/set", { update: { singleton: patch } }],
        ["VacationResponse/get", { ids: ["singleton"] }],
      ],
      signal,
      { attempt },
    );
    single(result, "updated", "singleton");
    const found = entry(expect(getList, current).list, "singleton");
    if (!found) throw new SafeError("WRITE_OUTCOME_UNKNOWN");
    return vacationResult(found);
  },
});
