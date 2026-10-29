export const heartbeatTimeoutMs = 15000;
export const heartbeatRecoveryMs = 120000;

// A late heartbeat is evidence of a delay, not a dead controller. Give the
// controller a fresh recovery window; IPC disconnect still stops it immediately.
export class WorkerLease {
  constructor({
    notify,
    expire,
    now = () => performance.now(),
    schedule = setTimeout,
    cancel = clearTimeout,
  }) {
    Object.assign(this, { notify, expire, now, schedule, cancel });
    this.timeoutMs = heartbeatTimeoutMs;
    this.recoveryMs = heartbeatRecoveryMs;
    this.renew();
  }
  renew({ timeoutMs, recoveryMs } = {}) {
    if (this.closed) return;
    if (Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000)
      this.timeoutMs = timeoutMs;
    if (
      Number.isInteger(recoveryMs) &&
      recoveryMs >= 100 &&
      recoveryMs <= 300000
    )
      this.recoveryMs = recoveryMs;
    const now = this.now();
    if (this.delayed)
      this.notify({
        type: "heartbeatRecovered",
        silenceMs: Math.round(now - this.lastSeen),
      });
    this.delayed = false;
    this.lastSeen = now;
    this.arm(this.timeoutMs);
  }
  arm(ms) {
    this.cancel(this.timer);
    this.deadline = this.now() + ms;
    this.timer = this.schedule(() => this.check(), ms);
  }
  check() {
    if (this.closed) return;
    const now = this.now();
    // A suspended machine delays the supervisor too. After it wakes, allow a
    // new handshake instead of racing overdue timers against queued IPC traffic.
    const supervisorDelayed =
      now - this.deadline > Math.max(1000, this.timeoutMs);
    if (!this.delayed || supervisorDelayed) {
      this.delayed = true;
      this.notify({
        type: "heartbeatDelayed",
        silenceMs: Math.round(now - this.lastSeen),
        recoveryMs: this.recoveryMs,
        supervisorDelayed,
      });
      this.arm(this.recoveryMs);
      return;
    }
    const silenceMs = Math.round(now - this.lastSeen);
    this.close();
    this.expire({ type: "leaseExpired", silenceMs });
  }
  close() {
    this.closed = true;
    this.cancel(this.timer);
  }
}
