import { afterEach, describe, expect, test } from "bun:test";
import { connected, type Connected } from "../fixtures/client.ts";
import { answer } from "../fixtures/answer.ts";
import type { MethodCall } from "../fixtures/stalwart.ts";

let env: Connected;
afterEach(() => env.stop());
const request = (index: number) => env.stalwart.jmapRequests[index]!;

const script =
  'require "fileinto";\nif header :contains "subject" "invoice" { fileinto "Bills"; }\n';
const upload = {
  created: { script: { id: "blob1", type: "application/sieve", size: 80 } },
};

describe("sieve", () => {
  test("validation uploads the text, then asks the server's parser", async () => {
    env = await connected({ writes: ["sieve"] });
    env.stalwart.jmap = answer({
      "Blob/upload": upload,
      "SieveScript/validate": { error: null },
    });
    expect(
      (await env.call("pim_validate_sieve_script", { content: script }))
        .structured,
    ).toEqual({
      valid: true,
      error: null,
    });
    // Stalwart 0.15 resolves blob creation IDs in SieveScript/set but not
    // in SieveScript/validate, so the upload is its own request.
    const [[uploadName, uploadArgs]] = request(0).calls as [MethodCall];
    expect(uploadName).toBe("Blob/upload");
    expect(uploadArgs.create).toEqual({
      script: { data: [{ "data:asText": script }], type: "application/sieve" },
    });
    expect(request(0).using).toEqual(
      expect.arrayContaining(["urn:ietf:params:jmap:blob"]),
    );
    const [[validate, validateArgs]] = request(1).calls as [MethodCall];
    expect(validate).toBe("SieveScript/validate");
    expect(validateArgs.blobId).toBe("blob1");
    expect(request(1).using).toContain("urn:ietf:params:jmap:sieve");

    env.stalwart.jmap = answer({
      "Blob/upload": upload,
      "SieveScript/validate": {
        error: { type: "invalidSieve", description: "line 1: unknown command" },
      },
    });
    expect(
      (await env.call("pim_validate_sieve_script", { content: "bogus;" }))
        .structured,
    ).toEqual({
      valid: false,
      error: "line 1: unknown command",
    });
  });

  test("saving creates or replaces a script and can activate it", async () => {
    env = await connected({ writes: ["sieve"] });
    env.stalwart.jmap = answer({
      "Blob/upload": upload,
      "SieveScript/set": { created: { new: { id: "s9" } } },
    });
    expect(
      (
        await env.call("pim_save_sieve_script", {
          name: "filters",
          content: script,
          activate: true,
        })
      ).structured,
    ).toEqual({
      script_id: "s9",
      name: "filters",
      activated: true,
    });
    const set = request(0).calls[1]![1];
    expect(set.create).toEqual({ new: { name: "filters", blobId: "#script" } });
    expect(set.onSuccessActivateScript).toBe("#new");

    env.stalwart.jmap = answer({
      "Blob/upload": upload,
      "SieveScript/set": { updated: { s9: null } },
    });
    await env.call("pim_save_sieve_script", {
      script_id: "s9",
      name: "filters",
      content: script,
    });
    expect(request(1).calls[1]![1]).toEqual({
      accountId: "a1",
      update: { s9: { name: "filters", blobId: "#script" } },
    });
  });

  test("an invalid script is refused without changing anything", async () => {
    env = await connected({ writes: ["sieve"] });
    env.stalwart.jmap = answer({
      "Blob/upload": upload,
      "SieveScript/set": {
        notCreated: { new: { type: "invalidScript", description: "syntax" } },
      },
    });
    expect(
      (
        await env.call("pim_save_sieve_script", {
          name: "x",
          content: "bogus;",
        })
      ).error?.code,
    ).toBe("INVALID_REQUEST");
  });

  test("activation is confirmed by reading the scripts back", async () => {
    env = await connected({ writes: ["sieve"] });
    env.stalwart.jmap = answer({
      "SieveScript/set": {},
      "SieveScript/get": {
        list: [
          { id: "s1", name: "a", isActive: false, blobId: "b" },
          { id: "s2", name: "b", isActive: true, blobId: "c" },
        ],
      },
    });
    expect(
      (await env.call("pim_activate_sieve_script", { script_id: "s2" }))
        .structured,
    ).toEqual({ active_script_id: "s2" });
    expect(request(0).calls[0]![1]).toMatchObject({
      onSuccessActivateScript: "s2",
    });
    expect(
      (await env.call("pim_activate_sieve_script", { script_id: "s1" })).error
        ?.code,
    ).toBe("WRITE_OUTCOME_UNKNOWN");
    env.stalwart.jmap = answer({
      "SieveScript/set": {},
      "SieveScript/get": {
        list: [{ id: "s1", name: "a", isActive: false, blobId: "b" }],
      },
    });
    expect(
      (await env.call("pim_activate_sieve_script", { script_id: null }))
        .structured,
    ).toEqual({ active_script_id: null });
    expect(request(2).calls[0]![1]).toMatchObject({
      onSuccessDeactivateScript: true,
    });
  });

  test("deleting the active script is refused by the server", async () => {
    env = await connected({ writes: ["sieve"] });
    env.stalwart.jmap = answer({
      "SieveScript/set": { notDestroyed: { s1: { type: "scriptIsActive" } } },
    });
    expect(
      (await env.call("pim_delete_sieve_script", { script_id: "s1" })).error
        ?.code,
    ).toBe("WRITE_REJECTED");
  });
});

describe("vacation", () => {
  test("sets the auto-reply and reads it back", async () => {
    env = await connected({ writes: ["vacation"] });
    env.stalwart.jmap = answer({
      "VacationResponse/set": { updated: { singleton: null } },
      "VacationResponse/get": {
        list: [
          {
            id: "singleton",
            isEnabled: true,
            fromDate: null,
            toDate: "2026-11-20T00:00:00Z",
            subject: "Away",
            textBody: "Back on the 20th",
          },
        ],
      },
    });
    const result = await env.call("pim_set_vacation", {
      enabled: true,
      to_date: "2026-11-20T09:00:00+09:00",
      subject: "Away",
      text_body: "Back on the 20th",
    });
    expect(result.structured).toEqual({
      enabled: true,
      from_date: null,
      to_date: "2026-11-20T00:00:00Z",
      subject: "Away",
      text_body: "Back on the 20th",
    });
    const [[set, args], [get]] = request(0).calls as [MethodCall, MethodCall];
    expect(set).toBe("VacationResponse/set");
    expect(args.update).toEqual({
      singleton: {
        isEnabled: true,
        toDate: "2026-11-20T00:00:00Z",
        subject: "Away",
        textBody: "Back on the 20th",
      },
    });
    expect(get).toBe("VacationResponse/get");
  });
});
