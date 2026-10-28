/**
 * Paseo 0.11 usage-source bridge: feeds this plugin's Kimi / GLM / Codex /
 * Command Code accounts into the host's built-in usage UI (Usage modal and
 * pinned window bars), so the quota numbers show up next to the native
 * Claude/Codex entries instead of only on the plugin's own screen.
 *
 * Card titles in the Usage modal come from the usage *source* label, and the
 * host takes a **snapshot of the source list the moment contribute() returns**
 * (the child's "ready" message; the daemon publishes exactly that list once at
 * plugin start, with no re-publish API). So every source is registered
 * synchronously inside contribute — never from async continuations.
 *
 * Per-account naming needs the settings labels at that moment, which the async
 * settings API cannot provide before contribute returns. The labels are
 * therefore bootstrapped with a best-effort synchronous read of the daemon's
 * settings file (the documented ~/.paseo/plugin-settings path); discover()/
 * fetch() still go through the official async settings API so deletions and
 * quota reads stay live. If the file cannot be read, registration degrades to
 * one provider-named source per provider (old behavior, account labels in the
 * card footer) instead of failing.
 *
 * Consequences of the static registration:
 *   - deleted entries disappear immediately (discover() re-reads settings);
 *   - disabled entries (enabled === false) stay registered but discover()
 *     returns no accounts for them, so their cards hide without a reload;
 *   - entries added after load are caught by the per-provider catch-all source
 *     and show up as e.g. "Kimi（新订阅）" until the plugin is reloaded
 *     (daemon restart), which also applies to renamed labels.
 *
 * Account model: every configured Kimi key, GLM key, Command Code key, and the
 * Codex CLI login is one UsageAccount. Inputs name the credential store
 * (settings entry id or the auth.json path); credentials themselves never
 * leave the daemon.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  unavailable,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageDetail,
  type UsageReport,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  CodexReport,
  CommandCodeReport,
  GlmReport,
  KimiReport,
  QuotaSettingsValues,
} from "../shared/quota";
import { formatMoney, formatPeriodEndCountdown } from "../shared/format";
import type { UsageAccount } from "@getpaseo/plugin/server/usage";
import {
  codexAccountHint,
  fetchCodex,
  fetchCommandCode,
  fetchGlm,
  fetchKimi,
} from "./quota";

const inputSchema = z
  .object({
    provider: z.enum(["kimi", "glm", "codex", "commandcode"]),
    /** Settings entry id for kimi/glm/commandcode; ignored for codex. */
    entryId: z.string().optional(),
    /** Codex auth.json path marker. Discovery fills it; fetch re-reads the file. */
    path: z.string().optional(),
  })
  .strict();

type SourceInput = z.infer<typeof inputSchema>;
type ProviderKind = "kimi" | "glm" | "commandcode";

function errorReport(error: string | null, httpStatus: number | null): UsageReport {
  if (httpStatus === 401) return unavailable({ kind: "rejected", status: 401 });
  if (httpStatus === 403) return unavailable({ kind: "rejected", status: 403 });
  return { status: "error", error: error ?? "查询失败" };
}

/**
 * One detail row with a window's exact reset time. The host renders a window's
 * resetsAt as a coarse "resets in 1 day" string that the plugin cannot style,
 * so the precise countdown goes into details, which pass strings through
 * verbatim. Returns null when there is no reset time or it is unparseable.
 */
export function windowResetDetail(
  id: string,
  windowLabel: string,
  resetAt: string | null,
): UsageDetail | null {
  if (!resetAt) return null;
  const value = formatPeriodEndCountdown(resetAt);
  if (!value) return null;
  return { id, label: `${windowLabel}重置`, value };
}

function kimiWindows(report: KimiReport): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (report.fiveHour) {
    windows.push(
      windowFromReportedDuration({
        durationSeconds: 5 * 3600,
        unknown: { id: "kimi-5h", label: "5 小时窗口", shortLabel: "5h" },
        utilizationPct: report.fiveHour.usedRatio * 100,
        resetsAt: report.fiveHour.resetAt,
        summary: true,
      }),
    );
  }
  if (report.weekly) {
    windows.push(
      windowFromUsedPct({
        id: "kimi-weekly",
        label: "每周窗口",
        shortLabel: "wk",
        summary: true,
        utilizationPct: report.weekly.usedRatio * 100,
        resetsAt: report.weekly.resetAt,
      }),
    );
  }
  if (report.monthly) {
    windows.push(
      windowFromUsedPct({
        id: "kimi-monthly",
        label: "每月窗口",
        shortLabel: "mo",
        utilizationPct: report.monthly.usedRatio * 100,
        resetsAt: report.monthly.resetAt,
      }),
    );
  }
  return windows;
}

function glmWindows(report: GlmReport): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (report.fiveHour) {
    windows.push(
      windowFromReportedDuration({
        durationSeconds: 5 * 3600,
        unknown: { id: "glm-5h", label: "5 小时 token 窗口", shortLabel: "5h" },
        utilizationPct: report.fiveHour.usedRatio * 100,
        resetsAt: report.fiveHour.resetAt,
        summary: true,
      }),
    );
  }
  if (report.weekly) {
    windows.push(
      windowFromUsedPct({
        id: "glm-weekly",
        label: "每周 token 窗口",
        shortLabel: "wk",
        summary: true,
        utilizationPct: report.weekly.usedRatio * 100,
        resetsAt: report.weekly.resetAt,
      }),
    );
  }
  return windows;
}

const CODEX_WINDOW_SECONDS: Record<string, number> = {
  "5 小时窗口": 5 * 3600,
  "每周窗口": 7 * 86400,
};

function codexWindows(report: CodexReport): UsageWindow[] {
  return report.windows.map((window, index) => {
    const duration = CODEX_WINDOW_SECONDS[window.label] ?? null;
    const base = {
      utilizationPct: window.usedRatio * 100,
      resetsAt: window.resetAt,
      summary: index === 0,
    };
    return duration
      ? windowFromReportedDuration({
          durationSeconds: duration,
          unknown: { id: `codex-${index}`, label: window.label, shortLabel: "win" },
          ...base,
        })
      : windowFromUsedPct({
          id: `codex-${index}`,
          label: window.label,
          ...base,
        });
  });
}

async function readValues(
  readSettings: () => Promise<QuotaSettingsValues>,
): Promise<QuotaSettingsValues> {
  return readSettings().catch(() => ({ kimi: [], glm: [], commandcode: [], codexEnabled: true }));
}

function entriesOf(
  config: QuotaSettingsValues,
  provider: ProviderKind,
): { id: string; label: string; key: string; enabled: boolean }[] {
  if (provider === "kimi") return config.kimi;
  if (provider === "glm") return config.glm;
  return config.commandcode ?? [];
}

const HARNESS: Record<ProviderKind, string> = {
  kimi: "Kimi",
  glm: "GLM",
  commandcode: "CmdCode",
};

/** Source ids must match the host pattern ^[a-z][a-z0-9._-]*$. */
function sanitizeIdPart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "x";
}

interface BootEntry {
  id: string;
  label: string;
  key: string;
  enabled: boolean;
}

function bootEntries(value: unknown): BootEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: BootEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.key !== "string" || record.key === "") continue;
    entries.push({
      id: record.id,
      label: typeof record.label === "string" ? record.label : "",
      key: record.key,
      enabled: record.enabled !== false,
    });
  }
  return entries;
}

/**
 * Best-effort synchronous read of the daemon's settings file, used only to
 * name the per-account usage sources before contribute() returns (the host
 * snapshots the source list at that moment). The official async settings API
 * remains the source of truth for everything discover()/fetch() do.
 */
export function readBootSettings(path: string = join(
  process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
  "plugin-settings",
  "paseo-coding-quota",
  "coding-quota.json",
)): QuotaSettingsValues | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    // The daemon writes either the raw values or a { values, ... } envelope.
    const values = (raw.values && typeof raw.values === "object" ? raw.values : raw) as Record<
      string,
      unknown
    >;
    const kimi = bootEntries(values.kimi);
    const glm = bootEntries(values.glm);
    const commandcode = bootEntries(values.commandcode);
    if (kimi.length === 0 && glm.length === 0 && commandcode.length === 0) return null;
    return { kimi, glm, commandcode, codexEnabled: values.codexEnabled !== false };
  } catch {
    return null;
  }
}

export function registerCodingQuotaUsageSource(
  server: PluginServerContext,
  readSettings: () => Promise<QuotaSettingsValues>,
): void {
  /** Entry ids that own a dedicated source; catch-alls skip them. */
  const covered: Record<ProviderKind, Set<string>> = {
    kimi: new Set(),
    glm: new Set(),
    commandcode: new Set(),
  };
  const usedSourceIds = new Set<string>();
  const uniqueSourceId = (base: string): string => {
    let id = base;
    for (let n = 2; usedSourceIds.has(id); n += 1) id = `${base}-${n}`;
    usedSourceIds.add(id);
    return id;
  };

  const fetchByProvider = async (rawInput: unknown): Promise<UsageReport> => {
    const input = inputSchema.parse(rawInput);
    if (input.provider === "kimi") {
      const config = await readValues(readSettings);
      const entry = config.kimi.find((item) => item.id === input.entryId);
      if (!entry) return unavailable({ kind: "no_quota", detail: "该 Kimi 订阅已从设置中删除" });
      const result = await fetchKimi(entry);
      if (!result.report.ok) return errorReport(result.report.error, result.httpStatus);
      const windows = kimiWindows(result.report);
      const wallet = result.report.wallet;
      // The host only knows USD/credits/requests/tokens units, so the CNY
      // wallet goes into plain detail rows instead of a mislabeled "$" bar.
      const details: UsageDetail[] = [];
      for (const row of [
        windowResetDetail("kimi-5h-reset", "5 小时窗口", result.report.fiveHour?.resetAt ?? null),
        windowResetDetail("kimi-weekly-reset", "每周窗口", result.report.weekly?.resetAt ?? null),
        windowResetDetail("kimi-monthly-reset", "每月窗口", result.report.monthly?.resetAt ?? null),
      ]) {
        if (row) details.push(row);
      }
      if (wallet) {
        details.push({
          id: "kimi-wallet-used",
          label: "月度钱包已用",
          value: formatMoney(wallet.monthlyUsedYuan, wallet.currency),
        });
        if (wallet.monthlyLimitYuan !== null) {
          details.push({
            id: "kimi-wallet-limit",
            label: "月度钱包上限",
            value: formatMoney(wallet.monthlyLimitYuan, wallet.currency),
          });
        }
        details.push({
          id: "kimi-wallet-balance",
          label: "钱包余额",
          value: formatMoney(wallet.balanceYuan, wallet.currency),
        });
      }
      if (windows.length === 0 && details.length === 0) {
        return unavailable({ kind: "no_quota", detail: "该订阅未返回额度窗口" });
      }
      return {
        status: "available",
        planLabel: `Kimi ···${result.report.keyTail}`,
        windows,
        details: details.length > 0 ? details : undefined,
      };
    }
    if (input.provider === "glm") {
      const config = await readValues(readSettings);
      const entry = config.glm.find((item) => item.id === input.entryId);
      if (!entry) return unavailable({ kind: "no_quota", detail: "该 GLM 订阅已从设置中删除" });
      const result = await fetchGlm(entry);
      if (!result.report.ok) return errorReport(result.report.error, result.httpStatus);
      const windows = glmWindows(result.report);
      const details: UsageDetail[] = [];
      for (const row of [
        windowResetDetail("glm-5h-reset", "5 小时 token 窗口", result.report.fiveHour?.resetAt ?? null),
        windowResetDetail("glm-weekly-reset", "每周 token 窗口", result.report.weekly?.resetAt ?? null),
      ]) {
        if (row) details.push(row);
      }
      if (result.report.toolCalls) {
        details.push({
          id: "glm-tool-calls",
          label: "月度工具调用",
          value: `${result.report.toolCalls.used}/${result.report.toolCalls.limit} 次`,
        });
      }
      if (windows.length === 0 && details.length === 0) {
        return unavailable({ kind: "no_quota", detail: "该账号未返回额度窗口" });
      }
      return {
        status: "available",
        planLabel: `GLM ${result.report.level ?? ""} ···${result.report.keyTail}`.trim(),
        windows,
        details: details.length > 0 ? details : undefined,
      };
    }
    if (input.provider === "commandcode") {
      const config = await readValues(readSettings);
      const entry = (config.commandcode ?? []).find((item) => item.id === input.entryId);
      if (!entry) return unavailable({ kind: "no_quota", detail: "该 Command Code 订阅已从设置中删除" });
      const result = await fetchCommandCode(entry);
      if (!result.report.ok) return errorReport(result.report.error, result.httpStatus);
      const report = result.report;
      const windows: UsageWindow[] = [];
      if (report.fiveHour) {
        windows.push(
          windowFromReportedDuration({
            durationSeconds: 5 * 3600,
            unknown: { id: "cc-5h", label: "5 小时窗口", shortLabel: "5h" },
            utilizationPct: report.fiveHour.usedRatio * 100,
            resetsAt: report.fiveHour.resetAt,
            summary: true,
          }),
        );
      }
      if (report.weekly) {
        windows.push(
          windowFromUsedPct({
            id: "cc-weekly",
            label: "每周窗口",
            shortLabel: "wk",
            summary: true,
            utilizationPct: report.weekly.usedRatio * 100,
            resetsAt: report.weekly.resetAt,
          }),
        );
      }
      const cancelPending =
        report.cancelAtPeriodEnd || report.cancelAt !== null || report.canceledAt !== null;
      const endIso = report.cancelAt ?? report.periodEnd;
      const details: { id: string; label: string; value: string }[] = [];
      for (const row of [
        windowResetDetail("cc-5h-reset", "5 小时窗口", report.fiveHour?.resetAt ?? null),
        windowResetDetail("cc-weekly-reset", "每周窗口", report.weekly?.resetAt ?? null),
      ]) {
        if (row) details.push(row);
      }
      if (report.monthlyCredits !== null) {
        details.push({ id: "cc-monthly", label: "月度剩余额度", value: `$${report.monthlyCredits.toFixed(2)}` });
      }
      if (report.purchasedCredits !== null && report.purchasedCredits > 0) {
        details.push({ id: "cc-purchased", label: "已购额度余额", value: `$${report.purchasedCredits.toFixed(2)}` });
      }
      if (endIso) {
        details.push({
          id: "cc-period-end",
          label: cancelPending ? "到期（不续订）" : "账期截止",
          value: formatPeriodEndCountdown(endIso) || endIso.slice(0, 10),
        });
      }
      if (report.user) {
        details.push({ id: "cc-user", label: "账号", value: report.user });
      }
      if (windows.length === 0 && details.length === 0) {
        return unavailable({ kind: "no_quota", detail: "该账号未返回额度窗口" });
      }
      const planBits = [report.plan, report.status].filter(Boolean).join(" · ");
      const cancelSuffix = cancelPending ? " · 不续订" : "";
      return {
        status: "available",
        planLabel: planBits
          ? `CmdCode ${planBits}${cancelSuffix}`
          : `CmdCode ···${report.keyTail}${cancelSuffix}`,
        windows,
        details,
      };
    }
    // codex
    const result = await fetchCodex();
    if (!result) return unavailable({ kind: "no_quota", detail: "未找到 ~/.codex/auth.json" });
    if (!result.report.ok) {
      if (result.httpStatus === 401) {
        return unavailable({ kind: "rejected", status: 401, refreshedBy: "codex" });
      }
      return errorReport(result.report.error, result.httpStatus);
    }
    const windows = codexWindows(result.report);
    if (windows.length === 0) {
      return unavailable({ kind: "no_quota", detail: "该账号未返回额度窗口" });
    }
    const details: UsageDetail[] = [];
    result.report.windows.forEach((window, index) => {
      const row = windowResetDetail(`codex-win-${index}-reset`, window.label, window.resetAt);
      if (row) details.push(row);
    });
    if (result.report.email) {
      details.push({ id: "codex-email", label: "账号", value: result.report.email });
    }
    return {
      status: "available",
      planLabel: result.report.plan ? `Codex ${result.report.plan}` : "Codex",
      windows,
      details: details.length > 0 ? details : undefined,
    };
  };

  const accountSource = (
    provider: ProviderKind,
    entryId: string,
    label: string,
  ): UsageSourceRegistration => ({
    id: uniqueSourceId(`coding-quota.${provider === "commandcode" ? "cc" : provider}.${sanitizeIdPart(entryId)}`),
    label,
    input: inputSchema,

    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readValues(readSettings);
      // Re-read live: a deleted or disabled entry drops its card without waiting for a reload.
      const entry = entriesOf(config, provider).find((item) => item.id === entryId);
      if (!entry || entry.enabled === false) return [];
      const accounts: UsageAccount[] = [
        {
          key: `${provider}-${entryId}`,
          harness: HARNESS[provider],
          input: { provider, entryId } satisfies SourceInput,
        },
      ];
      return accounts;
    },

    fetch: fetchByProvider,
  });

  const catchAllSource = (provider: ProviderKind, label: string): UsageSourceRegistration => ({
    id: uniqueSourceId(
      `coding-quota.${provider === "commandcode" ? "cc" : provider}-extra`,
    ),
    label,
    input: inputSchema,

    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readValues(readSettings);
      return entriesOf(config, provider)
        .filter((item) => item.enabled !== false && !covered[provider].has(item.id))
        .map(
          (item): UsageAccount => ({
            key: `${provider}-${item.id}`,
            harness: HARNESS[provider],
            input: { provider, entryId: item.id } satisfies SourceInput,
          }),
        );
    },

    fetch: fetchByProvider,
  });

  const codexSource: UsageSourceRegistration = {
    id: uniqueSourceId("coding-quota.codex"),
    label: "Codex（ChatGPT）",
    input: inputSchema,

    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readValues(readSettings);
      if (!config.codexEnabled) return [];
      const hint = codexAccountHint();
      if (!hint) return [];
      return [
        {
          key: `codex-${hint.accountId ?? "default"}`,
          harness: "Codex",
          input: { provider: "codex" } satisfies SourceInput,
        },
      ];
    },

    fetch: fetchByProvider,
  };

  /** Fallback when the settings file is unreadable: one provider-named source. */
  const providerSource = (provider: ProviderKind, label: string): UsageSourceRegistration => ({
    id: uniqueSourceId(`coding-quota.${provider === "commandcode" ? "cc" : provider}`),
    label,
    input: inputSchema,

    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readValues(readSettings);
      return entriesOf(config, provider)
        .filter((item) => item.enabled !== false)
        .map(
          (item): UsageAccount => ({
            key: `${provider}-${item.id}`,
            // Shown in the card footer; the title stays provider-named.
            label: item.label || undefined,
            harness: HARNESS[provider],
            input: { provider, entryId: item.id } satisfies SourceInput,
          }),
        );
    },

    fetch: fetchByProvider,
  });

  // Everything must be registered before contribute() returns: the host
  // snapshots the source list at that moment and never re-publishes.
  const boot = readBootSettings();
  if (boot) {
    for (const provider of ["kimi", "glm", "commandcode"] as const) {
      entriesOf(boot, provider).forEach((entry, index) => {
        covered[provider].add(entry.id);
        const fallbackLabel = `${HARNESS[provider]} ${index + 1}`;
        server.registerUsageSource(
          accountSource(provider, entry.id, entry.label.trim() || fallbackLabel),
        );
      });
      server.registerUsageSource(catchAllSource(provider, `${HARNESS[provider]}（新订阅）`));
    }
  } else {
    console.warn(
      "[coding-quota] could not read the settings file for card titles; " +
        "falling back to one provider-named usage source per provider",
    );
    server.registerUsageSource(providerSource("kimi", "Kimi"));
    server.registerUsageSource(providerSource("glm", "GLM"));
    server.registerUsageSource(providerSource("commandcode", "CmdCode"));
  }
  server.registerUsageSource(codexSource);
}
