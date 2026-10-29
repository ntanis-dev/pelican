// Pelican runs only while something uses it, the way Baton does: a call in
// flight or made within the idle time (the menu asks every 2 s, a wait holds
// its call open), agents running or queued to run, or a workflow run. When
// none of that has been so for idleMs, onIdle is called and the service
// exits; the next command starts it again.
export function watchIdle({ gateway, idleMs, onIdle, now = Date.now }) {
  // The service has just started: whoever started it is about to call.
  let busyAt = now();
  let timer = null;
  const stop = () => clearInterval(timer);
  const check = () => {
    const busy = gateway.busy();
    if (busy.calls || busy.agents || busy.runs) busyAt = now();
    if (now() - Math.max(busyAt, busy.lastCall) < idleMs) return;
    stop();
    onIdle();
  };
  timer = setInterval(check, Math.min(30000, Math.max(200, idleMs / 4)));
  timer.unref();
  return { check, stop };
}
