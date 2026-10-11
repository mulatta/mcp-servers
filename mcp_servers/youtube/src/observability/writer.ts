import type { Writable } from "node:stream";

type Record = { line: string; bytes: number };

export class BoundedWriter {
  private queue: Record[] = [];
  private records = 0;
  private bytes = 0;
  private dropped = 0;
  private unreported = 0;
  private recovered = false;
  private paused = false;
  private scheduled = false;
  private disabled = false;
  private closing = false;
  private closed: Promise<void> | undefined;
  private settle: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private sink: Writable,
    private lossRecord: (count: number) => string | undefined,
  ) {
    sink.on("error", this.disable);
    sink.on("drain", this.drain);
    sink.once("close", this.dispose);
  }

  get usage() {
    return {
      records: this.records,
      bytes: this.bytes,
      dropped: this.dropped,
      disabled: this.disabled,
    };
  }

  write(line: string) {
    if (this.disabled || this.closing) return;
    const record = { line, bytes: Buffer.byteLength(line) };
    if (!this.enqueue(record)) {
      this.dropped++;
      this.unreported++;
      this.recovered = false;
    }
    this.schedule();
  }

  private enqueue(record: Record) {
    if (this.records >= 256 || this.bytes + record.bytes > 256 * 1024)
      return false;
    this.queue.push(record);
    this.records++;
    this.bytes += record.bytes;
    return true;
  }

  private schedule() {
    if (this.scheduled || this.disabled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump() {
    if (this.disabled) return;
    if (this.unreported && this.recovered) {
      const line = this.lossRecord(this.unreported);
      if (
        line === undefined ||
        this.enqueue({ line, bytes: Buffer.byteLength(line) })
      )
        this.unreported = 0;
    }
    while (!this.disabled && !this.paused && this.queue.length) {
      const record = this.queue.shift()!;
      try {
        const ready = this.sink.write(record.line, (error) => {
          if (error) {
            this.disable();
            return;
          }
          if (this.disabled) return;
          this.records--;
          this.bytes -= record.bytes;
          this.recovered = true;
          this.schedule();
        });
        if (!ready) this.paused = true;
      } catch {
        this.disable();
      }
    }
    if (this.closing && !this.records) this.disable();
  }

  private drain = () => {
    this.paused = false;
    this.schedule();
  };

  private disable = () => {
    this.disabled = true;
    this.queue = [];
    this.records = 0;
    this.bytes = 0;
    this.sink.off("drain", this.drain);
    clearTimeout(this.timer);
    this.settle?.();
  };

  private dispose = () => {
    this.disable();
    this.sink.off("error", this.disable);
    this.sink.off("close", this.dispose);
  };

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
    if (this.disabled) this.settle?.();
    else {
      this.timer = setTimeout(this.disable, 1000);
      this.schedule();
    }
    // Keep the error guard until the stream closes: timed-out writes can fail later.
    return this.closed;
  }
}
