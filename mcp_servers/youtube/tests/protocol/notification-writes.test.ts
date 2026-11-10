import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.ts";
import { createBackend } from "../../src/reader.ts";
import type { WriteGroup } from "../../src/config.ts";
import { libraryServer } from "../fixtures/library-server.ts";

// channels.json lists these two subscriptions with fixture-<setting>-<n> bell params.
const first = "UCfixture000000000000001";
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const states = {
  all: "SUBSCRIPTION_NOTIFICATION_STATE_ALL",
  personalized: "SUBSCRIPTION_NOTIFICATION_STATE_OCCASIONAL",
  none: "SUBSCRIPTION_NOTIFICATION_STATE_OFF",
};
// Shape observed live: the new bell comes back as a subscriptionNotificationStateEntity.
const stateResponse = (state: string) => ({
  frameworkUpdates: {
    entityBatchUpdate: {
      mutations: [
        {
          type: "ENTITY_MUTATION_TYPE_REPLACE",
          payload: {
            subscriptionNotificationStateEntity: { key: "fixture", state },
          },
        },
      ],
    },
  },
});

type Write = { path: string; body: Record<string, unknown> };
async function connect(
  options: {
    writes?: WriteGroup[];
    onWrite?: (body: Record<string, unknown>) => Response;
  } = {},
) {
  const writes: Write[] = [];
  const f = libraryServer({
    onWrite: (path, body) => {
      writes.push({ path, body });
      if (options.onWrite) return options.onWrite(body);
      const setting = /^fixture-(\w+)-/.exec(
        String(body.params),
      )?.[1] as keyof typeof states;
      return Response.json(stateResponse(states[setting]));
    },
  });
  const backend = createBackend({ cdpUrl: f.browser.url, network: f.network });
  const server = createServer(backend.reader, {
    writer: backend.writer,
    writes: new Set(options.writes ?? ["notification"]),
  });
  const client = new Client({ name: "notification-writes-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  cleanups.push(async () => {
    await client.close();
    await server.close();
    f.close();
  });
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({
      name: "youtube_set_channel_notifications",
      arguments: args,
    });
    const text = (result.content as { text?: string }[])?.[0]?.text ?? "";
    return {
      result,
      code: result.isError
        ? (/"code":"(\w+)"/.exec(text)?.[1] ?? "invalid")
        : "ok",
    };
  };
  return { client, call, writes, f };
}

test("the bell tool is absent and unreachable unless the notification group is enabled", async () => {
  for (const groups of [
    [],
    ["subscription"],
    ["playlist", "rating"],
  ] as WriteGroup[][]) {
    const { client, call, writes } = await connect({ writes: groups });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("youtube_set_channel_notifications");
    expect((await call({ channel_id: first, setting: "none" })).code).toBe(
      "invalid",
    );
    expect(writes).toEqual([]);
  }
});

test("channel and setting are checked before any request", async () => {
  const { call, writes, f } = await connect();
  for (const args of [
    { channel_id: "@handle", setting: "all" },
    { channel_id: first, setting: "ALL" },
    { channel_id: first, setting: "occasional" },
    { channel_id: first },
  ])
    expect((await call(args)).code).toBe("invalid");
  expect(writes).toEqual([]);
  expect(f.paths).toEqual([]);
});

test("each setting posts the params YouTube offered for that channel and setting", async () => {
  for (const setting of ["all", "personalized", "none"] as const) {
    const { call, writes } = await connect();
    const { result } = await call({ channel_id: first, setting });
    expect(result.structuredContent).toEqual({
      account_id: "UCaaaaaaaaaaaaaaaaaaaaaa",
      channel_id: first,
      notification: setting,
    });
    expect(writes).toEqual([
      {
        path: "/youtubei/v1/notification/modify_channel_preference",
        body: expect.objectContaining({ params: `fixture-${setting}-1` }),
      },
    ]);
  }
});

test("a channel that is not subscribed is refused without a write", async () => {
  const { call, writes } = await connect();
  expect(
    (await call({ channel_id: "UCfixture000000000000009", setting: "all" }))
      .code,
  ).toBe("CHANNEL_NOT_SUBSCRIBED");
  expect(writes).toEqual([]);
});

test("a bell change is confirmed only by the matching notification state", async () => {
  for (const [label, response] of [
    ["no mutation", () => Response.json({})],
    ["other state", () => Response.json(stateResponse(states.none))],
  ] as const) {
    const { call, writes } = await connect({ onWrite: response });
    expect({
      label,
      code: (await call({ channel_id: first, setting: "all" })).code,
    }).toEqual({
      label,
      code: "WRITE_OUTCOME_UNKNOWN",
    });
    expect(writes).toHaveLength(1);
  }
});

test("changing the bell is not declared destructive", async () => {
  const { client } = await connect();
  const tool = (await client.listTools()).tools.find(
    (t) => t.name === "youtube_set_channel_notifications",
  );
  expect(tool?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
});
