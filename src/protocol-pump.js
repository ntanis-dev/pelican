import { createInterface } from "node:readline";

const textDeltas = new Set([
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/plan/delta",
]);

// CLI output can arrive one short line at a time. Bound each event-loop turn and
// join adjacent text chunks before the durable journal does a synchronous write.
// Requests, completions and metadata changes are ordering barriers, never merged.
export class ProtocolPump {
  constructor(input, deliver, diagnostic) {
    this.input = input;
    this.deliver = deliver;
    this.diagnostic = diagnostic;
    this.lines = [];
    this.bytes = 0;
    this.pending = null;
    this.timer = null;
    this.scheduled = false;
    this.stopped = false;
    this.readerClosed = false;
    this.reader = createInterface({ input });
    this.reader.on("close", () => {
      this.readerClosed = true;
    });
    this.reader.on("line", (line) => {
      this.lines.push(line);
      this.bytes += line.length;
      if (this.lines.length >= 128 || this.bytes >= 1024 * 1024)
        this.reader.pause();
      this.schedule();
    });
  }
  schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => this.drain());
  }
  drain() {
    this.scheduled = false;
    if (this.stopped) return;
    const start = performance.now();
    let consumed = 0;
    while (
      consumed < this.lines.length &&
      consumed < 128 &&
      performance.now() - start < 4
    ) {
      const line = this.lines[consumed++];
      this.bytes -= line.length;
      try {
        this.accept(JSON.parse(line));
      } catch (error) {
        this.flush();
        this.diagnostic({
          message: `Protocol parse error: ${error.message}`,
          line: line.slice(0, 2000),
        });
      }
    }
    this.lines.splice(0, consumed);
    if (this.lines.length) this.schedule();
    else {
      if (!this.readerClosed) this.reader.resume();
      if (this.onDrained && !this.lines.length) {
        this.flush();
        const done = this.onDrained;
        this.onDrained = null;
        done();
      }
    }
  }
  accept(message) {
    const params = message.params;
    if (
      message.id === undefined &&
      textDeltas.has(message.method) &&
      typeof params?.delta === "string"
    ) {
      const key = JSON.stringify({
        ...message,
        params: { ...params, delta: undefined },
      });
      if (
        this.pending &&
        (this.pending.key !== key ||
          this.pending.message.params.delta.length + params.delta.length >
            32 * 1024)
      )
        this.flush();
      if (this.pending) this.pending.message.params.delta += params.delta;
      else this.pending = { key, message };
      this.timer ??= setTimeout(() => this.flush(), 20);
      if (this.pending.message.params.delta.length >= 32 * 1024) this.flush();
      return;
    }
    this.flush();
    this.deliver(message);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const { message } = this.pending;
    this.pending = null;
    this.deliver(message);
  }
  end(callback) {
    this.onDrained = callback;
    this.schedule();
  }
  close() {
    this.stopped = true;
    this.reader.close();
    this.lines = [];
    this.bytes = 0;
    this.flush();
  }
}
