export {};

if (process.env.YOUTUBE_LIVE_READONLY !== "1") {
  console.error(
    "Live reads disabled. Obtain approval before setting YOUTUBE_LIVE_READONLY=1.",
  );
  process.exit(2);
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } =
  await import("@modelcontextprotocol/sdk/client/stdio.js");
const { checkTools } = await import("./check-tools.ts");
const { safeError } = await import("../../src/errors.ts");
const { DiagnosticCollector } = await import("./diagnostics.ts");
const client = new Client({ name: "youtube-live-check", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../../src/index.ts", import.meta.url).pathname],
  env: {
    YOUTUBE_CDP_URL: process.env.YOUTUBE_CDP_URL ?? "http://127.0.0.1:9222",
    YOUTUBE_LOG_LEVEL: process.env.YOUTUBE_LOG_LEVEL ?? "info",
  },
  stderr: "pipe",
});
const diagnostics = new DiagnosticCollector();
// Retain only a bounded partial line, never echo server diagnostics.
transport.stderr?.on("data", (chunk) => diagnostics.push(chunk));
try {
  await client.connect(transport, { timeout: 5000 });
  const reports = await checkTools(client);
  for (const report of reports) console.log(JSON.stringify(report));
  if (reports.some((report) => report.status === "error")) process.exitCode = 1;
} catch (error) {
  console.error(safeError(error).message);
  process.exitCode = 1;
} finally {
  await client.close();
  const summary = diagnostics.finish();
  console.log(
    JSON.stringify({
      server_stderr_bytes: summary.bytes,
      diagnostic_records: summary.records,
      diagnostics_valid: summary.valid,
    }),
  );
  if (!summary.valid) process.exitCode = 1;
}
