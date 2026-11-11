import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, toolNames } from "../../src/server.ts";
import { SafeError } from "../../src/errors.ts";
import { writeGroups } from "../../src/config.ts";

// Hermes passes only tool descriptions and error messages to its model, so the
// write caveats must live there; instructions serve clients that read them.
async function connect() {
  const server = createServer(undefined, {
    writer: async () => ({}),
    writes: new Set(writeGroups),
  });
  const client = new Client({ name: "guidance-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [
      tool.name,
      tool.description ?? "",
    ]),
  );
  return {
    client,
    tools,
    close: () => Promise.all([client.close(), server.close()]),
  };
}

test("write tool descriptions carry the caveats a caller must know", async () => {
  const { tools, close } = await connect();
  try {
    const caveats: Record<string, RegExp[]> = {
      youtube_create_playlist: [
        /Not idempotent/,
        /WRITE_OUTCOME_UNKNOWN/,
        /second playlist/,
      ],
      youtube_delete_playlist: [/Permanent/],
      youtube_add_to_playlist: [
        /duplicate entry/,
        /WRITE_OUTCOME_UNKNOWN/,
        /Watch Later/,
      ],
      youtube_remove_from_playlist: [
        /every entry/,
        /duplicates/,
        /Watch Later/,
      ],
      youtube_move_in_playlist: [
        /after_video_id/,
        /before_video_id/,
        /to the top/,
        /listed twice/,
      ],
      youtube_update_playlist: [/privacy/, /PRIVATE, UNLISTED or PUBLIC/],
      youtube_like_video: [/repeating is harmless/],
      youtube_remove_rating: [/repeating is harmless/],
      youtube_subscribe: [/after ~6 s/],
      youtube_unsubscribe: [/after ~6 s/],
      youtube_set_channel_notifications: [
        /subscribes to/,
        /CHANNEL_NOT_SUBSCRIBED/,
        /subscribe first/,
      ],
    };
    for (const [name, patterns] of Object.entries(caveats))
      for (const pattern of patterns)
        expect({ name, description: tools[name] }).toEqual({
          name,
          description: expect.stringMatching(pattern),
        });
  } finally {
    await close();
  }
});

test("list tool descriptions warn that old cursors predate writes", async () => {
  const { tools, close } = await connect();
  try {
    for (const name of toolNames)
      expect({ name, description: tools[name] }).toEqual({
        name,
        description: expect.stringContaining(
          "A cursor from before a write returns pre-write results",
        ),
      });
  } finally {
    await close();
  }
});

test("server instructions describe the whole write flow", async () => {
  const { client, close } = await connect();
  try {
    const instructions = client.getInstructions() ?? "";
    for (const pattern of [
      /sent once and never retried/,
      /Watch Later up to ~20 s/,
      /retry the read, not the write/,
      /WRITE_OUTCOME_UNKNOWN means the write may have happened/,
      /duplicates/,
      /removes all its entries/,
      /before_video_id with the first video moves to the top/,
      /only for subscribed channels/,
    ])
      expect(instructions).toMatch(pattern);
  } finally {
    await close();
  }
});

test("error messages tell the caller what to do next", () => {
  expect(new SafeError("WRITE_OUTCOME_UNKNOWN").message).toMatch(
    /repeating a create or add can duplicate it/,
  );
  expect(new SafeError("CHANNEL_NOT_SUBSCRIBED").message).toMatch(
    /Subscribe first\./,
  );
});
