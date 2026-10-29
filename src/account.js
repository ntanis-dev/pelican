import { CodexProcess } from "./codex.js";

// The account's usage limits are read when the service starts and then every
// half hour; a read on request is at most one a minute.
export const usageEveryMs = 30 * 60000;
const usageGapMs = 60000;
const noUsage = {
  at: null,
  error: null,
  plan: null,
  allowed: null,
  reached: null,
  limits: [],
  credits: null,
};
// A window's reset time arrives as Unix seconds.
const resetAt = (n) =>
  n === null || n === undefined
    ? null
    : new Date(n > 1e11 ? n : n * 1000).toISOString();
const usageWindow = (w) => ({
  usedPercent: w.usedPercent,
  windowMinutes: w.windowDurationMins ?? null,
  resetsAt: resetAt(w.resetsAt),
});
// What account/rateLimits/read said, as Pelican shows it: each metered limit
// with its rolling windows (the short one and the weekly one), the plan, the
// credits, and whether a limit is reached.
export function summarizeUsage(response, at = new Date().toISOString()) {
  const own = Object.entries(response.rateLimitsByLimitId ?? {}).filter(
    ([, bucket]) => bucket,
  );
  const buckets = own.length
    ? own
    : [[response.rateLimits?.limitId ?? "codex", response.rateLimits]];
  const main = response.rateLimits ?? null;
  return {
    at,
    error: null,
    plan: main?.planType ?? null,
    allowed: response.ordinaryUsageAllowed ?? null,
    reached: main?.rateLimitReachedType ?? null,
    limits: buckets
      .filter(([, b]) => b && (b.primary || b.secondary))
      .map(([id, b]) => ({
        id,
        name: b.limitName ?? id,
        windows: [b.primary, b.secondary].filter(Boolean).map(usageWindow),
      })),
    credits: main?.credits
      ? {
          unlimited: Boolean(main.credits.unlimited),
          has: Boolean(main.credits.hasCredits),
          balance: main.credits.balance ?? null,
        }
      : null,
  };
}

// Codex owns credential storage and refresh. Only account metadata and the
// temporary browser login URL cross this adapter; credentials never do.
export class CodexAccount {
  constructor({ config, processFactory } = {}) {
    this.factory =
      processFactory ?? (() => new CodexProcess({ bin: config.codexBin }));
    this.login = null;
    this.error = null;
    this.reading = null;
  }
  // The last reading of the usage limits, read now when there is none yet
  // (refresh reads again, at most once a minute). A failed read keeps the
  // last good numbers and says what went wrong in `error`.
  async usage({ refresh = false } = {}) {
    const recent =
      this.reading?.at && Date.now() - Date.parse(this.reading.at) < usageGapMs;
    if (this.reading && (!refresh || recent)) return this.reading;
    return this.readUsage();
  }
  readUsage() {
    this.usageRead ??= (async () => {
      try {
        const proc = await this.connection();
        const response = await proc.request("account/rateLimits/read", {
          excludeResetCreditDetails: true,
        });
        this.reading = summarizeUsage(response);
      } catch (error) {
        this.reading = { ...(this.reading ?? noUsage), error: error.message };
      }
      return this.reading;
    })().finally(() => {
      this.usageRead = null;
    });
    return this.usageRead;
  }
  // While the service runs: read the limits now and every half hour.
  watchUsage(everyMs = usageEveryMs) {
    if (this.usageTimer) return;
    void this.readUsage();
    this.usageTimer = setInterval(() => void this.readUsage(), everyMs);
    this.usageTimer.unref();
  }
  async connection() {
    if (!this.connecting) {
      const proc = this.factory();
      this.proc = proc;
      proc.on("request", ({ id }) =>
        proc.reject(id, "Account connection does not run agent tools"),
      );
      proc.on("notification", ({ method, params }) => {
        if (
          method === "account/login/completed" &&
          params.loginId === this.login?.loginId
        ) {
          this.login = null;
          this.error = params.success
            ? null
            : params.error || "ChatGPT sign-in failed. Try again.";
        }
      });
      proc.on("exit", () => {
        if (this.proc !== proc) return;
        if (this.login) this.error = "Sign-in was interrupted. Try again.";
        this.login = null;
        this.connecting = null;
      });
      this.connecting = proc
        .start()
        .then(() => proc)
        .catch(async (error) => {
          this.connecting = null;
          await proc.close();
          throw error;
        });
    }
    return this.connecting;
  }
  async status() {
    const proc = await this.connection();
    const result = await proc.request("account/read", { refreshToken: false });
    const account = result.account;
    return {
      connected: account?.type === "chatgpt",
      account: account
        ? { type: account.type, plan: account.planType ?? null }
        : null,
      login: this.login ? { authUrl: this.login.authUrl } : null,
      error: this.error,
    };
  }
  async startLogin() {
    if (this.starting) return this.starting;
    this.starting = this.beginLogin();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async beginLogin() {
    const state = await this.status();
    if (state.connected || this.login) return state;
    this.error = null;
    const proc = await this.connection();
    const result = await proc.request("account/login/start", {
      type: "chatgpt",
    });
    const url = new URL(result.authUrl);
    if (
      result.type !== "chatgpt" ||
      url.protocol !== "https:" ||
      url.hostname !== "auth.openai.com"
    ) {
      if (result.loginId)
        await proc.request("account/login/cancel", { loginId: result.loginId });
      throw new Error("Codex returned an unexpected ChatGPT sign-in URL");
    }
    this.login = { loginId: result.loginId, authUrl: url.href };
    return { ...state, login: { authUrl: url.href }, error: null };
  }
  async cancelLogin() {
    if (this.starting) await this.starting;
    const login = this.login;
    this.login = null;
    this.error = null;
    if (login && this.proc && !this.proc.closed)
      await this.proc.request("account/login/cancel", {
        loginId: login.loginId,
      });
    return { cancelled: true };
  }
  async close() {
    clearInterval(this.usageTimer);
    this.usageTimer = null;
    await this.proc?.close();
    this.proc = null;
    this.connecting = null;
    this.login = null;
  }
}
