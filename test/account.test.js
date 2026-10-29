import test from "node:test";
import assert from "node:assert/strict";
import { CodexAccount } from "../src/account.js";
import { FakeWorker, until } from "./helpers.js";

function fixture(t) {
  const worker = new FakeWorker();
  let account = null;
  let url = "https://auth.openai.com/oauth/authorize?state=test";
  worker.request = async (method, params) => {
    worker.requests.push({ method, params });
    if (method === "account/read") return { account, requiresOpenaiAuth: true };
    if (method === "account/login/start")
      return { type: "chatgpt", loginId: "login-1", authUrl: url };
    return {};
  };
  const service = new CodexAccount({ processFactory: () => worker });
  t.after(() => service.close());
  return {
    service,
    worker,
    setAccount: (value) => {
      account = value;
    },
    setUrl: (value) => {
      url = value;
    },
  };
}

test("existing ChatGPT login is reused without requesting or exposing credentials", async (t) => {
  const { service, worker, setAccount } = fixture(t);
  setAccount({
    type: "chatgpt",
    email: "private@example.test",
    planType: "pro",
    accessToken: "must-not-expose",
  });
  const state = await service.startLogin();
  assert.deepEqual(state.account, { type: "chatgpt", plan: "pro" });
  assert.equal(state.connected, true);
  assert.equal(state.login, null);
  assert.equal(
    worker.requests.some((r) => r.method === "account/login/start"),
    false,
  );
  assert.doesNotMatch(JSON.stringify(state), /private|must-not-expose/);
});

test("ChatGPT login is deduplicated, completes, and reports failures and cancellation", async (t) => {
  const { service, worker, setAccount } = fixture(t);
  const [a, b] = await Promise.all([
    service.startLogin(),
    service.startLogin(),
  ]);
  assert.equal(a.login.authUrl, b.login.authUrl);
  assert.equal(
    worker.requests.filter((r) => r.method === "account/login/start").length,
    1,
  );
  worker.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "unrelated", success: true },
  });
  assert.ok((await service.status()).login);
  setAccount({ type: "chatgpt", planType: "plus" });
  worker.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "login-1", success: true },
  });
  assert.equal((await service.status()).connected, true);
  assert.equal((await service.status()).login, null);
  setAccount(null);
  await service.startLogin();
  worker.emit("notification", {
    method: "account/login/completed",
    params: { loginId: "login-1", success: false, error: "Login expired" },
  });
  assert.equal((await service.status()).error, "Login expired");
  await service.startLogin();
  await service.cancelLogin();
  assert.deepEqual(worker.requests.at(-1), {
    method: "account/login/cancel",
    params: { loginId: "login-1" },
  });
  assert.equal((await service.status()).login, null);
  assert.equal((await service.status()).error, null);
});

test("unexpected authentication URLs are cancelled and never forwarded to the browser", async (t) => {
  const { service, worker, setUrl } = fixture(t);
  setUrl("https://attacker.invalid/signin");
  await assert.rejects(service.startLogin(), /unexpected ChatGPT sign-in URL/);
  assert.equal(worker.requests.at(-1).method, "account/login/cancel");
  assert.equal((await service.status()).login, null);
});

const limit = (extra = {}) => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 34.5, windowDurationMins: 300, resetsAt: 1798000000 },
  secondary: {
    usedPercent: 12,
    windowDurationMins: 10080,
    resetsAt: 1798400000,
  },
  credits: { hasCredits: false, unlimited: false, balance: null },
  individualLimit: null,
  spendControlReached: null,
  planType: "pro",
  rateLimitReachedType: null,
  ...extra,
});
const reading = (extra) => ({
  ordinaryUsageAllowed: true,
  rateLimits: limit(extra),
  rateLimitsByLimitId: { codex: limit(extra) },
  rateLimitResetCredits: null,
  accountId: null,
  rateLimitUpsell: null,
});
function usageFixture(t, answer) {
  const worker = new FakeWorker();
  worker.request = async (method, params) => {
    worker.requests.push({ method, params });
    if (method === "account/rateLimits/read") return answer();
    return {};
  };
  const service = new CodexAccount({ processFactory: () => worker });
  t.after(() => service.close());
  return { service, worker };
}
const reads = (worker) =>
  worker.requests.filter((r) => r.method === "account/rateLimits/read");

test("usage limits are read once, summarised and kept until they are asked for again", async (t) => {
  let used = 34.5;
  const { service, worker } = usageFixture(t, () =>
    reading({
      primary: {
        usedPercent: used,
        windowDurationMins: 300,
        resetsAt: 1798000000,
      },
    }),
  );
  const first = await service.usage();
  assert.deepEqual(first, {
    at: first.at,
    error: null,
    plan: "pro",
    allowed: true,
    reached: null,
    credits: { unlimited: false, has: false, balance: null },
    limits: [
      {
        id: "codex",
        name: "codex",
        windows: [
          {
            usedPercent: 34.5,
            windowMinutes: 300,
            resetsAt: new Date(1798000000 * 1000).toISOString(),
          },
          {
            usedPercent: 12,
            windowMinutes: 10080,
            resetsAt: new Date(1798400000 * 1000).toISOString(),
          },
        ],
      },
    ],
  });
  assert.deepEqual(reads(worker)[0].params, {
    excludeResetCreditDetails: true,
  });
  // Asking again reads nothing; refresh within a minute does not either.
  used = 50;
  assert.equal(await service.usage(), first);
  assert.equal(await service.usage({ refresh: true }), first);
  assert.equal(reads(worker).length, 1);
  // A minute later refresh reads again.
  service.reading = {
    ...first,
    at: new Date(Date.now() - 61000).toISOString(),
  };
  const again = await service.usage({ refresh: true });
  assert.equal(again.limits[0].windows[0].usedPercent, 50);
  assert.equal(reads(worker).length, 2);
});

test("a failed usage read keeps the last good numbers and says what went wrong", async (t) => {
  let fail = false;
  const { service } = usageFixture(t, () => {
    if (fail) throw new Error("Not signed in");
    return reading({ rateLimitReachedType: "rate_limit_reached" });
  });
  const good = await service.usage();
  assert.equal(good.reached, "rate_limit_reached");
  fail = true;
  service.reading = { ...good, at: new Date(Date.now() - 61000).toISOString() };
  const bad = await service.usage({ refresh: true });
  assert.equal(bad.error, "Not signed in");
  assert.deepEqual(bad.limits, good.limits);
  assert.equal(bad.at, service.reading.at);
  // Nothing was ever read: no numbers, and the error.
  const none = usageFixture(t, () => {
    throw new Error("Codex is not installed");
  });
  const empty = await none.service.usage();
  assert.equal(empty.at, null);
  assert.deepEqual(empty.limits, []);
  assert.equal(empty.error, "Codex is not installed");
});

test("watching reads the limits at once and on every interval until it closes", async (t) => {
  const { service, worker } = usageFixture(t, () => reading());
  service.watchUsage(20);
  service.watchUsage(20);
  await until(() => reads(worker).length >= 3);
  await service.close();
  const count = reads(worker).length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads(worker).length, count);
});
