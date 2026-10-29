import test from "node:test";
import assert from "node:assert/strict";
import { WorkerLease } from "../src/worker-lease.js";

function fixture() {
  let now = 0,
    timer;
  const notices = [],
    expired = [];
  const lease = new WorkerLease({
    now: () => now,
    schedule: (fn, ms) => {
      timer = { fn, at: now + ms };
      return timer;
    },
    cancel: () => {
      timer = null;
    },
    notify: (event) => notices.push(event),
    expire: (event) => expired.push(event),
  });
  return {
    lease,
    notices,
    expired,
    fire: (at = timer.at) => {
      now = at;
      timer.fn();
    },
    get timer() {
      return timer;
    },
  };
}
test("15 seconds of missing heartbeats starts recovery rather than killing the worker", () => {
  const f = fixture();
  f.fire();
  assert.equal(f.notices[0].type, "heartbeatDelayed");
  assert.equal(f.expired.length, 0);
  assert.equal(f.timer.at, 135000);
  f.lease.renew();
  assert.equal(f.notices.at(-1).type, "heartbeatRecovered");
  f.fire();
  assert.equal(f.expired.length, 0);
  f.fire();
  assert.equal(f.expired.length, 1);
});
test("resume from sleep gives the controller time to answer even during recovery", () => {
  const f = fixture();
  f.fire(3600000);
  assert.equal(f.expired.length, 0);
  f.fire(7200000);
  assert.equal(f.expired.length, 0);
  assert.equal(f.notices.at(-1).supervisorDelayed, true);
  f.lease.renew();
  assert.equal(f.notices.at(-1).type, "heartbeatRecovered");
  f.lease.close();
  f.lease.renew();
  assert.equal(f.timer, null);
});
