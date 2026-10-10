/**
 * Quota fetching for Kimi / GLM / Codex coding plans.
 *
 * Endpoints (all reverse-engineered from the official clients, 2026-10):
 *  - Kimi:  GET https://api.kimi.com/coding/v1/usages  (Bearer api key)
 *           body.usages.limit_5h / limit_7d / limit_month_total:
 *           { used_ratio: 0..1, reset_time: ISO }
 *           body.booster_wallet.balance.amount / .amountLeft: 1e6 fixed-point
 *           cents (amountLeft omitted once exhausted → official CLI treats as 0)
 *           body.booster_wallet.monthlyUsed / .monthlyChargeLimit:
 *           { currency, priceInCents } in real cents
 *  - GLM:   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit (Bearer api key)
 *           data.limits[]: TOKENS_LIMIT unit=3 (5h) / unit=6 (weekly),
 *           TIME_LIMIT unit=5 (monthly tool calls); percentage 0..100,
 *           nextResetTime in epoch ms
 *  - Codex: GET https://chatgpt.com/backend-api/wham/usage (ChatGPT OAuth)
 *           tokens from ~/.codex/auth.json (CODEX_HOME honored);
 *           rate_limit.primary_window / secondary_window:
 *           { used_percent: 0..100, limit_window_seconds, reset_at: epoch s }
 *           chatgpt.com usually needs a proxy on this machine, so Codex
 *           requests go through the detected system/env proxy while Kimi and
 *           GLM stay direct.
 *  - Command Code (commandcode.ai): three parallel calls on
 *           https://api.commandcode.ai —
 *             GET /alpha/whoami?limits=1            → { user: {email,userName}, org }
 *             GET /alpha/billing/credits            → { credits: {monthlyCredits,
 *                                                       purchasedCredits, freeCredits},
 *                                                       windowLimits: {fiveHour{used,
 *                                                       cap,resetAt}, weekly{…}} }
 *             GET /alpha/billing/subscriptions      → { data: {planId,status,
 *                                                       currentPeriodEnd} }
 *           Bearer user_… API key. api.commandcode.ai also needs the proxy on
 *           this machine (direct connect times out), same as chatgpt.com.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetch, ProxyAgent, type Dispatcher } from "undici";
import type { CodexReport, CommandCodeReport, GlmReport, KimiReport, QuotaReport, QuotaSettingsValues } from "../shared/quota";

const TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 30_000;

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COMMANDCODE_BASE = "https://api.commandcode.ai";

// ---------------------------------------------------------------------------
// HTTP helpers

let proxyUrlCache: string | null | undefined;
let proxyAgent: ProxyAgent | null = null;

function normalizeProxy(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function detectProxyUrl(): string | null {
  if (proxyUrlCache !== undefined) return proxyUrlCache;
  const fromEnv =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (fromEnv) {
    proxyUrlCache = normalizeProxy(fromEnv);
    return proxyUrlCache;
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyServer"],
        { encoding: "utf8", timeout: 3000, windowsHide: true },
      );
      const match = out.match(/ProxyServer\s+REG_(?:SZ|EXPAND_SZ)\s+(\S+)/);
      if (match) {
        proxyUrlCache = normalizeProxy(match[1]);
        return proxyUrlCache;
      }
    } catch {
      // registry read failed; fall through to direct
    }
  }
  proxyUrlCache = null;
  return proxyUrlCache;
}

function getProxyDispatcher(): Dispatcher | undefined {
  const url = detectProxyUrl();
  if (!url) return undefined;
  proxyAgent ??= new ProxyAgent(url);
  return proxyAgent;
}

async function httpJson(
  url: string,
  headers: Record<string, string>,
  options: { proxy?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  const init: { headers: Record<string, string>; dispatcher?: Dispatcher; signal: AbortSignal } = {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (options.proxy) {
    const dispatcher = getProxyDispatcher();
    if (dispatcher) init.dispatcher = dispatcher;
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

function extractError(body: unknown): string {
  if (body && typeof body === "object") {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err.slice(0, 200);
    if (err && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg.slice(0, 200);
    }
  }
  return JSON.stringify(body).slice(0, 200);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
  return String(error).slice(0, 240);
}

function clamp01(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}

function isoFromEpochSeconds(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

function isoFromEpochMs(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Accepts an ISO string or an epoch number (seconds or milliseconds); null otherwise. */
function isoFromUnknown(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kimi

function mapKimiWindow(window: unknown): { usedRatio: number; resetAt: string | null } | null {
  if (!window || typeof window !== "object") return null;
  const record = window as Record<string, unknown>;
  const usedRatio = clamp01(record.used_ratio);
  if (usedRatio === null) return null;
  const resetTime = record.reset_time;
  return { usedRatio, resetAt: typeof resetTime === "string" ? resetTime : null };
}

// The booster wallet carries two different money encodings: balance.amount /
// balance.amountLeft are 1e6 fixed-point cents (FIXED_POINT_CENTS in the
// official CLI), while monthlyUsed / monthlyChargeLimit / topup prices are
// plain cents in priceInCents. Missing amountLeft means the wallet is empty
// (the API omits the field at zero), matching the official CLI's ?? 0.
const KIMI_FIXED_POINT_CENTS = 1e6;

function intFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function centsFromMoney(money: unknown): { cents: number; currency: string } | null {
  if (!money || typeof money !== "object") return null;
  const record = money as Record<string, unknown>;
  const cents = intFromUnknown(record.priceInCents);
  if (cents === null) return null;
  return { cents, currency: typeof record.currency === "string" ? record.currency : "" };
}

function mapKimiWallet(wallet: unknown): KimiReport["wallet"] {
  if (!wallet || typeof wallet !== "object") return null;
  const record = wallet as Record<string, unknown>;
  const balance = record.balance as Record<string, unknown> | undefined;
  const monthlyUsed = centsFromMoney(record.monthlyUsed);
  const monthlyLimit = centsFromMoney(record.monthlyChargeLimit);
  const monthlyChargeLimitEnabled = record.monthlyChargeLimitEnabled === true;

  let balanceYuan = 0;
  if (balance && typeof balance === "object") {
    const amountLeft = intFromUnknown(balance.amountLeft);
    balanceYuan = amountLeft !== null ? amountLeft / KIMI_FIXED_POINT_CENTS / 100 : 0;
  } else if (!monthlyUsed) {
    return null; // no balance object and no spend data — nothing to show
  }

  const currency =
    (monthlyLimit && monthlyLimit.currency) || (monthlyUsed && monthlyUsed.currency) || "USD";
  return {
    balanceYuan,
    monthlyLimitYuan:
      monthlyChargeLimitEnabled && monthlyLimit && monthlyLimit.cents > 0
        ? monthlyLimit.cents / 100
        : null,
    monthlyUsedYuan: (monthlyUsed?.cents ?? 0) / 100,
    currency,
  };
}

export function mapKimiBody(
  body: unknown,
): Pick<KimiReport, "fiveHour" | "weekly" | "monthly" | "wallet"> {
  const usages = (body as Record<string, unknown> | null)?.usages;
  const windows = (usages && typeof usages === "object" ? usages : {}) as Record<string, unknown>;
  const boosterWallet = (body as Record<string, unknown>)?.booster_wallet;
  return {
    fiveHour: mapKimiWindow(windows.limit_5h),
    weekly: mapKimiWindow(windows.limit_7d),
    monthly: mapKimiWindow(windows.limit_month_total),
    wallet: mapKimiWallet(boosterWallet),
  };
}

export interface QuotaFetch<R> {
  report: R;
  /** HTTP status of the upstream call; null when the request never got a response. */
  httpStatus: number | null;
}

export async function fetchKimi(entry: { id: string; label: string; key: string }): Promise<QuotaFetch<KimiReport>> {
  const keyTail = entry.key.slice(-6);
  const failed = (httpStatus: number | null, error: string): QuotaFetch<KimiReport> => ({
    httpStatus,
    report: {
      id: entry.id,
      label: entry.label,
      keyTail,
      ok: false,
      fiveHour: null,
      weekly: null,
      monthly: null,
      wallet: null,
      error,
    },
  });
  try {
    const { status, body } = await httpJson(KIMI_USAGE_URL, { Authorization: `Bearer ${entry.key}` });
    if (status !== 200) {
      return failed(
        status,
        status === 401 ? "API key 无效或已过期" : `HTTP ${status}: ${extractError(body)}`,
      );
    }
    return {
      httpStatus: status,
      report: { id: entry.id, label: entry.label, keyTail, ok: true, error: null, ...mapKimiBody(body) },
    };
  } catch (error) {
    return failed(null, errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// GLM

const GLM_UNITS: Record<number, string> = { 3: "小时", 5: "月", 6: "周" };

export function glmWindowLabel(unit: unknown, number: unknown): string {
  const unitLabel = GLM_UNITS[unit as number] ?? `unit${String(unit)}`;
  return number === 1 ? `每${unitLabel}` : `${String(number)} ${unitLabel}`;
}

export function mapGlmBody(
  body: unknown,
): Pick<GlmReport, "level" | "fiveHour" | "weekly" | "toolCalls"> {
  const data = (body as Record<string, unknown> | null)?.data as Record<string, unknown> | undefined;
  const level = typeof data?.level === "string" ? data.level : null;
  const result: Pick<GlmReport, "level" | "fiveHour" | "weekly" | "toolCalls"> = {
    level,
    fiveHour: null,
    weekly: null,
    toolCalls: null,
  };
  for (const limit of (data?.limits as Record<string, unknown>[] | undefined) ?? []) {
    const type = limit.type;
    const unit = limit.unit;
    const usedRatio = clamp01(typeof limit.percentage === "number" ? limit.percentage / 100 : null);
    const resetAt = isoFromEpochMs(limit.nextResetTime);
    if (usedRatio === null) continue;
    if (type === "TOKENS_LIMIT" && unit === 3) result.fiveHour = { usedRatio, resetAt };
    else if (type === "TOKENS_LIMIT" && unit === 6) result.weekly = { usedRatio, resetAt };
    else if (type === "TIME_LIMIT" && unit === 5) {
      const used = Number(limit.currentValue);
      const limitCount = Number(limit.usage);
      result.toolCalls = {
        used: Number.isFinite(used) ? used : 0,
        limit: Number.isFinite(limitCount) ? limitCount : 0,
        resetAt,
      };
    }
  }
  return result;
}

export async function fetchGlm(entry: { id: string; label: string; key: string }): Promise<QuotaFetch<GlmReport>> {
  const keyTail = entry.key.slice(-6);
  const failed = (httpStatus: number | null, error: string): QuotaFetch<GlmReport> => ({
    httpStatus,
    report: {
      id: entry.id,
      label: entry.label,
      keyTail,
      ok: false,
      level: null,
      fiveHour: null,
      weekly: null,
      toolCalls: null,
      error,
    },
  });
  try {
    const { status, body } = await httpJson(GLM_QUOTA_URL, { Authorization: `Bearer ${entry.key}` });
    if (status !== 200 || !(body as Record<string, unknown>)?.success) {
      return failed(status, `HTTP ${status}: ${extractError(body)}`);
    }
    return {
      httpStatus: status,
      report: { id: entry.id, label: entry.label, keyTail, ok: true, error: null, ...mapGlmBody(body) },
    };
  } catch (error) {
    return failed(null, errorMessage(error));
  }
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT plan, OAuth credentials from the Codex CLI)

export function codexWindowLabel(limitWindowSeconds: unknown): string {
  if (typeof limitWindowSeconds !== "number" || !Number.isFinite(limitWindowSeconds)) return "用量窗口";
  if (limitWindowSeconds === 300) return "5 小时窗口";
  if (limitWindowSeconds === 604800) return "每周窗口";
  if (limitWindowSeconds >= 86400 && limitWindowSeconds % 86400 === 0) {
    return `${Math.round(limitWindowSeconds / 86400)} 天窗口`;
  }
  return `${Math.max(1, Math.round(limitWindowSeconds / 3600))} 小时窗口`;
}

export function mapCodexBody(
  body: unknown,
): Pick<CodexReport, "email" | "plan" | "windows" | "credits"> {
  const record = (body ?? {}) as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email : null;
  const plan = typeof record.plan_type === "string" ? record.plan_type : null;
  const credits = record.credits as Record<string, unknown> | undefined;
  const balance = credits && typeof credits.balance === "string" ? credits.balance : null;
  const rateLimit = record.rate_limit as Record<string, unknown> | undefined;
  const windows: CodexReport["windows"] = [];
  for (const key of ["primary_window", "secondary_window"] as const) {
    const window = rateLimit?.[key] as Record<string, unknown> | null | undefined;
    if (!window || typeof window !== "object") continue;
    const usedRatio = clamp01(
      typeof window.used_percent === "number" ? window.used_percent / 100 : null,
    );
    if (usedRatio === null) continue;
    windows.push({
      label: codexWindowLabel(window.limit_window_seconds),
      usedRatio,
      resetAt: isoFromEpochSeconds(window.reset_at),
    });
  }
  return { email, plan, windows, credits: balance };
}

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return join(home, "auth.json");
}

function readCodexCredentials(): { accessToken: string; accountId: string | null } | null {
  const path = codexAuthPath();
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tokens = (auth.tokens && typeof auth.tokens === "object" ? auth.tokens : auth) as Record<string, unknown>;
    const accessToken =
      typeof tokens.access_token === "string" ? tokens.access_token : typeof auth.access_token === "string" ? (auth.access_token as string) : null;
    if (!accessToken) return null;
    const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

export function codexAccountHint(): { accountId: string | null } | null {
  const path = codexAuthPath();
  if (!existsSync(path)) return null;
  try {
    const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tokens = (auth.tokens && typeof auth.tokens === "object" ? auth.tokens : auth) as Record<
      string,
      unknown
    >;
    const accountId = typeof tokens.account_id === "string" ? tokens.account_id : null;
    return { accountId };
  } catch {
    return null;
  }
}

export async function fetchCodex(): Promise<QuotaFetch<CodexReport> | null> {
  const credentials = readCodexCredentials();
  if (!credentials) return null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    Accept: "application/json",
  };
  if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
  try {
    const { status, body } = await httpJson(CODEX_USAGE_URL, headers, { proxy: true });
    if (status === 401) {
      return {
        httpStatus: status,
        report: {
          ok: false,
          email: null,
          plan: null,
          windows: [],
          credits: null,
          error: "Codex 登录凭证已过期：在本机运行一次 codex（任意命令）让它自动刷新后重试",
        },
      };
    }
    if (status !== 200) {
      return {
        httpStatus: status,
        report: {
          ok: false,
          email: null,
          plan: null,
          windows: [],
          credits: null,
          error: `HTTP ${status}: ${extractError(body)}`,
        },
      };
    }
    return { httpStatus: status, report: { ok: true, error: null, ...mapCodexBody(body) } };
  } catch (error) {
    return {
      httpStatus: null,
      report: {
        ok: false,
        email: null,
        plan: null,
        windows: [],
        credits: null,
        error: `无法连接 chatgpt.com（可能需要代理）：${errorMessage(error)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Command Code (commandcode.ai) — Bearer API key, three parallel calls

interface CommandCodeWindow {
  used: number;
  cap: number;
  resetAt: number | null; // epoch ms
}

function mapCommandCodeWindow(window: unknown): { usedRatio: number; resetAt: string | null; used: number; cap: number } | null {
  if (!window || typeof window !== "object") return null;
  const record = window as Record<string, unknown>;
  const used = typeof record.used === "number" && Number.isFinite(record.used) ? record.used : null;
  const cap = typeof record.cap === "number" && Number.isFinite(record.cap) && record.cap > 0 ? record.cap : null;
  if (used === null || cap === null) return null;
  const resetAt = typeof record.resetAt === "number" && Number.isFinite(record.resetAt) ? record.resetAt : null;
  return {
    usedRatio: Math.min(1, Math.max(0, used / cap)),
    resetAt: resetAt !== null ? new Date(resetAt).toISOString() : null,
    used,
    cap,
  };
}

export function mapCommandCodeCredits(
  creditsBody: unknown,
  subscriptionBody: unknown,
  whoamiBody: unknown,
): Pick<
  CommandCodeReport,
  | "user"
  | "plan"
  | "status"
  | "periodEnd"
  | "cancelAtPeriodEnd"
  | "cancelAt"
  | "canceledAt"
  | "fiveHour"
  | "weekly"
  | "monthlyCredits"
  | "purchasedCredits"
> {
  const creditsRec = (creditsBody ?? {}) as Record<string, unknown>;
  const windowLimits = creditsRec.windowLimits as Record<string, unknown> | undefined;
  const credits = creditsRec.credits as Record<string, unknown> | undefined;

  const sub = (subscriptionBody ?? {}) as Record<string, unknown>;
  const subData = (sub.data ?? {}) as Record<string, unknown>;

  const whoami = (whoamiBody ?? {}) as Record<string, unknown>;
  const user = (whoami.user ?? {}) as Record<string, unknown>;

  const monthlyCredits = typeof credits?.monthlyCredits === "number" && Number.isFinite(credits.monthlyCredits) ? credits.monthlyCredits : null;
  const purchasedCredits = typeof credits?.purchasedCredits === "number" && Number.isFinite(credits.purchasedCredits) ? credits.purchasedCredits : null;

  const fiveHour = mapCommandCodeWindow(windowLimits?.fiveHour);
  const weekly = mapCommandCodeWindow(windowLimits?.weekly);

  return {
    user: typeof user.email === "string" ? user.email : typeof user.userName === "string" ? user.userName : null,
    plan: typeof subData.planId === "string" ? subData.planId : null,
    status: typeof subData.status === "string" ? subData.status : null,
    periodEnd: typeof subData.currentPeriodEnd === "string" ? subData.currentPeriodEnd : null,
    cancelAtPeriodEnd: subData.cancelAtPeriodEnd === true,
    cancelAt: isoFromUnknown(subData.cancelAt),
    canceledAt: isoFromUnknown(subData.canceledAt),
    fiveHour: fiveHour ? { usedRatio: fiveHour.usedRatio, resetAt: fiveHour.resetAt } : null,
    weekly: weekly ? { usedRatio: weekly.usedRatio, resetAt: weekly.resetAt } : null,
    monthlyCredits,
    purchasedCredits,
  };
}

export async function fetchCommandCode(entry: { id: string; label: string; key: string }): Promise<QuotaFetch<CommandCodeReport>> {
  const keyTail = entry.key.slice(-6);
  const failed = (httpStatus: number | null, error: string): QuotaFetch<CommandCodeReport> => ({
    httpStatus,
    report: {
      id: entry.id,
      label: entry.label,
      keyTail,
      ok: false,
      user: null,
      plan: null,
      status: null,
      periodEnd: null,
      cancelAtPeriodEnd: false,
      cancelAt: null,
      canceledAt: null,
      fiveHour: null,
      weekly: null,
      monthlyCredits: null,
      purchasedCredits: null,
      error,
    },
  });

  const headers = { Authorization: `Bearer ${entry.key}`, Accept: "application/json" };
  const opts = { proxy: true };
  try {
    const [whoamiRes, creditsRes, subRes] = await Promise.all([
      httpJson(`${COMMANDCODE_BASE}/alpha/whoami?limits=1`, headers, opts),
      httpJson(`${COMMANDCODE_BASE}/alpha/billing/credits`, headers, opts),
      httpJson(`${COMMANDCODE_BASE}/alpha/billing/subscriptions`, headers, opts),
    ]);

    // credits is the load-bearing call; whoami/subscriptions are optional enrichment.
    if (creditsRes.status === 401) {
      return failed(401, "API key 无效或已过期");
    }
    if (creditsRes.status !== 200) {
      return failed(creditsRes.status, `HTTP ${creditsRes.status}: ${extractError(creditsRes.body)}`);
    }

    const mapped = mapCommandCodeCredits(creditsRes.body, subRes.status === 200 ? subRes.body : null, whoamiRes.status === 200 ? whoamiRes.body : null);
    return {
      httpStatus: creditsRes.status,
      report: {
        id: entry.id,
        label: entry.label,
        keyTail,
        ok: true,
        error: null,
        ...mapped,
      },
    };
  } catch (error) {
    return failed(null, `无法连接 api.commandcode.ai（可能需要代理）：${errorMessage(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregated report with a small cache + single-flight

let cached: { at: number; data: QuotaReport } | null = null;
let inflight: Promise<QuotaReport> | null = null;

export async function getQuotaReport(
  readSettings: () => Promise<QuotaSettingsValues>,
): Promise<QuotaReport> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  if (!inflight) {
    inflight = (async () => {
      const config = await readSettings().catch(() => ({ kimi: [], glm: [], commandcode: [], codexEnabled: true }));
      const kimi = (await Promise.all(config.kimi.map(fetchKimi))).map((r) => r.report);
      const glm = (await Promise.all(config.glm.map(fetchGlm))).map((r) => r.report);
      const commandcode = (await Promise.all((config.commandcode ?? []).map(fetchCommandCode))).map((r) => r.report);
      const codexResult = config.codexEnabled ? await fetchCodex() : null;
      const codex = codexResult ? codexResult.report : null;
      return { fetchedAt: new Date().toISOString(), kimi, glm, codex, commandcode } satisfies QuotaReport;
    })()
      .then((data) => {
        cached = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
