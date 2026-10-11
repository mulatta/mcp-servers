import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { libraryServer } from "./library-server.ts";

// Own the actual pipe so tests can close it, not only the SDK's PassThrough.
export class PipeMcp implements Transport {
  onmessage?: NonNullable<Transport["onmessage"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  onclose?: NonNullable<Transport["onclose"]>;
  private child: ChildProcessWithoutNullStreams | undefined;
  exited: Promise<number | null> = Promise.resolve(null);
  constructor(
    private fixture: ReturnType<typeof libraryServer>,
    private broken: boolean,
  ) {}

  async start() {
    const child = spawn(
      process.execPath,
      [new URL("./mcp-worker.ts", import.meta.url).pathname],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          FIXTURE_CDP: this.fixture.browser.url,
          FIXTURE_UPSTREAM: `127.0.0.1:${this.fixture.upstream.port}`,
          YOUTUBE_LOG_LEVEL: "debug",
          FIXTURE_PRESSURE: "1",
        },
      },
    );
    this.child = child;
    this.exited = new Promise((resolve) =>
      child.once("exit", (code) => {
        this.onclose?.();
        resolve(code);
      }),
    );
    if (this.broken) child.stderr.destroy();
    // Otherwise stderr is deliberately never consumed or resumed.
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.onmessage?.(JSON.parse(line));
      } catch {
        this.onerror?.(new Error("Invalid fixture protocol output."));
      }
    });
    child.stdin.on("error", (error) => this.onerror?.(error));
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  async send(message: JSONRPCMessage) {
    if (!this.child) throw new Error("Fixture not connected.");
    const child = this.child;
    await new Promise<void>((resolve, reject) =>
      child.stdin.write(JSON.stringify(message) + "\n", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      child.stderr.destroy();
    }
  }
}
