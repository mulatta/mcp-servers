import { expect, test } from "bun:test";
import { createReader } from "../../src/reader.ts";
import { YoutubeClient } from "../../src/youtube/client.ts";
import { withRequest } from "../../src/observability/trace.ts";
import { resultSchema } from "../../src/youtube/normalize.ts";
import { captureDiagnostics } from "../fixtures/diagnostic-capture.ts";
import { libraryServer } from "../fixtures/library-server.ts";
import { accountPage } from "../fixtures/account.ts";
import playlist from "../fixtures/library/playlist.json";

test("real authentication and list reads trace identity, browse and normalization without private data", async () => {
  const f = libraryServer();
  const c = captureDiagnostics();
  try {
    const reader = createReader({ cdpUrl: f.browser.url, network: f.network });
    const result = resultSchema.parse(
      await withRequest(c.logger, "youtube_get_watch_later", 5, () =>
        reader(
          "youtube_get_watch_later",
          { limit: 5 },
          new AbortController().signal,
        ),
      ),
    );
    expect(f.paths).toHaveLength(2);
    const records = await c.finish();
    const requests = records.filter(
      (r) => r.event === "stage.end" && r.stage === "upstream.request",
    );
    expect(requests).toHaveLength(2);
    const identity = records.find(
      (r) => r.event === "stage.start" && r.stage === "auth.identity",
    );
    expect(requests[0].parent_stage_id).toBe(identity.stage_id);
    expect(requests[0].refresh_id).toBe(identity.refresh_id);
    expect(
      records.filter((r) => r.event === "stage.end" && r.stage === "normalize"),
    ).toHaveLength(1);
    const text = JSON.stringify(records);
    for (const forbidden of [
      result.account_id,
      "fixture-secret",
      "SAPISID",
      "/devtools/browser/",
    ])
      expect(text).not.toContain(forbidden);
    for (const item of result.items)
      if (item.title) expect(text).not.toContain(item.title);
  } finally {
    f.close();
  }
});

for (const failed of [false, true])
  test(`browse stage includes streamed body consumption and safe errors (failed=${failed})`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bodyStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests++;
        const body = await request.json();
        if (body.browseId === "SPaccount_advanced")
          return Response.json(accountPage("UCaaaaaaaaaaaaaaaaaaaaaa"));
        const text = JSON.stringify(
          failed ? { error: { message: "private-upstream-secret" } } : playlist,
        );
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(text.slice(0, 1)));
              entered();
              await gate;
              controller.enqueue(new TextEncoder().encode(text.slice(1)));
              controller.close();
            },
          }),
          {
            status: failed ? 403 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    const c = captureDiagnostics();
    const signal = new AbortController().signal;
    try {
      const pending = withRequest(
        c.logger,
        "youtube_get_watch_later",
        5,
        async () => {
          const { value } = await YoutubeClient.connect(
            "SAPISID=private-cookie",
            signal,
            (request) => {
              const url = new URL(request.url);
              url.protocol = "http:";
              url.host = `127.0.0.1:${server.port}`;
              return fetch(new Request(url, request));
            },
          );
          const page = await value.page(
            "youtube_get_watch_later",
            { limit: 5 },
            signal,
          );
          return { items: page.items };
        },
      ).catch(() => null);
      await bodyStarted;
      await Bun.sleep(20);
      release();
      const result = await pending;
      expect(result === null).toBe(failed);
      expect(requests).toBe(2);
      const records = await c.finish();
      const browses = records.filter(
        (r) => r.event === "stage.end" && r.stage === "upstream.request",
      );
      expect(browses).toHaveLength(2);
      expect(browses[1].duration_ms).toBeGreaterThanOrEqual(20);
      expect(browses[1].outcome).toBe(failed ? "error" : "ok");
      if (failed) expect(browses[1].code).toBe("PLAYLIST_UNAVAILABLE");
      expect(JSON.stringify(records)).not.toContain("private-");
    } finally {
      release();
      server.stop(true);
    }
  });
