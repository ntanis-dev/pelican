// Concurrent waits share one emitter listener. Every exit removes its timer,
// cancellation subscription and pending entry; a closed owner retains none.
export class EventWaiters {
  constructor(emitter) {
    this.emitter = emitter;
    this.pending = new Set();
    this.signals = new Map();
    this.closed = false;
    this.onEvent = (event) => {
      for (const entry of [...this.pending]) {
        try {
          if (entry.matches(event)) entry.finish(event);
        } catch (error) {
          entry.finish(null, error);
        }
      }
    };
  }
  wait({ matches = () => true, timeoutMs, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const entry = { matches };
      entry.finish = (event = null, error) => {
        if (!this.pending.delete(entry)) return;
        clearTimeout(entry.timer);
        if (signal) {
          const group = this.signals.get(signal);
          group.entries.delete(entry);
          if (!group.entries.size) {
            signal.removeEventListener("abort", group.abort);
            this.signals.delete(signal);
          }
        }
        if (!this.pending.size) this.emitter.off("event", this.onEvent);
        if (error) reject(error);
        else resolve(event);
      };
      if (!this.pending.size) this.emitter.on("event", this.onEvent);
      this.pending.add(entry);
      if (signal) {
        let group = this.signals.get(signal);
        if (!group) {
          group = {
            entries: new Set(),
            abort: () => {
              for (const pending of [...group.entries])
                pending.finish(null, signal.reason);
            },
          };
          this.signals.set(signal, group);
          signal.addEventListener("abort", group.abort, { once: true });
        }
        group.entries.add(entry);
      }
      if (timeoutMs !== undefined)
        entry.timer = setTimeout(() => entry.finish(), timeoutMs);
    });
  }
  close() {
    this.closed = true;
    for (const entry of [...this.pending]) entry.finish();
  }
}
