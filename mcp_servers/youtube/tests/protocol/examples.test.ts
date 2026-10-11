import { expect, test } from "bun:test";
import examples from "../../examples/results.json";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { toolNames } from "../../src/server.ts";

test("documented examples cover all five tools and satisfy output schema", () => {
  expect(Object.keys(examples)).toEqual([...toolNames]);
  for (const example of Object.values(examples)) {
    expect(resultSchema.safeParse(example).success).toBe(true);
    expect(example.has_more).toBe(example.next_cursor !== null);
  }
});
