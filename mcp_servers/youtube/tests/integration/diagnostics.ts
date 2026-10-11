import { validDiagnostic } from "../../src/observability/logger.ts";

export class DiagnosticCollector {
  private buffer = new Uint8Array(256 * 1024);
  private used = 0;
  private valid = true;
  private records = 0;
  private bytes = 0;

  push(chunk: Uint8Array) {
    this.bytes += chunk.byteLength;
    if (!this.valid) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (this.used + length + (newline < 0 ? 0 : 1) > this.buffer.length) {
        this.valid = false;
        this.used = 0;
        return;
      }
      this.buffer.set(chunk.subarray(start, end), this.used);
      this.used += length;
      if (newline < 0) return;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          this.buffer.subarray(0, this.used),
        );
        this.valid = validDiagnostic(JSON.parse(text));
      } catch {
        this.valid = false;
      }
      this.buffer.fill(0, 0, this.used);
      this.used = 0;
      if (!this.valid) return;
      this.records++;
      start = end + 1;
    }
  }

  finish() {
    if (this.used) this.valid = false;
    this.buffer.fill(0);
    this.used = 0;
    return { valid: this.valid, records: this.records, bytes: this.bytes };
  }
}
