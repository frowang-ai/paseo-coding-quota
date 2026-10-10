/**
 * Paseo 0.11 usage-source bridge: feeds this plugin's Kimi / GLM / Codex
 * accounts into the host's built-in usage UI (sidebar footer card and the
 * Usage modal), so the quota numbers show up next to the native Claude/Codex
 * entries instead of only on the plugin's own screen.
 *
 * Account model: every configured Kimi key, GLM key, and the Codex CLI login
 * is one UsageAccount. Inputs name the credential store (settings entry id or
 * the auth.json path); credentials themselves never leave the daemon.
 */
import { z } from "zod";
import {
  unavailable,
  windowFromReportedDuration,
  windowFromUsedPct,
  type UsageReport,
  type UsageSourceRegistration,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type {
  CodexReport,
  GlmReport,
  KimiReport,
  QuotaSettingsValues,
} from "../shared/quota";
import type { UsageAccount } from "@getpaseo/plugin/server/usage";
import {
  codexAccountHint,
  fetchCodex,
  fetchGlm,
  fetchKimi,
} from "./quota";

const inputSchema = z
  .object({
    provider: z.enum(["kimi", "glm", "codex"]),
    /** Settings entry id for kimi/glm; ignored for codex. */
    entryId: z.string().optional(),
    /** Codex auth.json path marker. Discovery fills it; fetch re-reads the file. */
    path: z.string().optional(),
  })
  .strict();

type SourceInput = z.infer<typeof inputSchema>;

function errorReport(error: string | null, httpStatus: number | null): UsageReport {
  if (httpStatus === 401) return unavailable({ kind: "rejected", status: 401 });
  if (httpStatus === 403) return unavailable({ kind: "rejected", status: 403 });
  return { status: "error", error: error ?? "查询失败" };
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
  return readSettings().catch(() => ({ kimi: [], glm: [], codexEnabled: true }));
}

export function registerCodingQuotaUsageSource(
  server: PluginServerContext,
  readSettings: () => Promise<QuotaSettingsValues>,
): void {
  const source: UsageSourceRegistration = {
    id: "coding-quota",
    label: "Coding 额度",
    input: inputSchema,

    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readValues(readSettings);
      const accounts: UsageAccount[] = [
        ...config.kimi.map((entry) => ({
          key: `kimi-${entry.id}`,
          label: entry.label,
          harness: "Kimi",
          input: { provider: "kimi", entryId: entry.id } satisfies SourceInput,
        })),
        ...config.glm.map((entry) => ({
          key: `glm-${entry.id}`,
          label: entry.label,
          harness: "GLM",
          input: { provider: "glm", entryId: entry.id } satisfies SourceInput,
        })),
      ];
      if (config.codexEnabled) {
        const hint = codexAccountHint();
        if (hint) {
          accounts.push({
            key: `codex-${hint.accountId ?? "default"}`,
            label: "Codex（ChatGPT）",
            harness: "Codex",
            input: { provider: "codex" } satisfies SourceInput,
          });
        }
      }
      return accounts;
    },

    async fetch(rawInput) {
      const input = inputSchema.parse(rawInput);
      if (input.provider === "kimi") {
        const config = await readValues(readSettings);
        const entry = config.kimi.find((item) => item.id === input.entryId);
        if (!entry) return unavailable({ kind: "no_quota", detail: "该 Kimi 订阅已从设置中删除" });
        const result = await fetchKimi(entry);
        if (!result.report.ok) return errorReport(result.report.error, result.httpStatus);
        const windows = kimiWindows(result.report);
        if (windows.length === 0 && !result.report.wallet) {
          return unavailable({ kind: "no_quota", detail: "该订阅未返回额度窗口" });
        }
        const wallet = result.report.wallet;
        return {
          status: "available",
          planLabel: `Kimi ···${result.report.keyTail}`,
          windows,
          balances: wallet
            ? [
                {
                  id: "kimi-wallet",
                  label: "月度钱包",
                  used: wallet.monthlyUsedYuan,
                  remaining: wallet.balanceYuan,
                  limit: wallet.monthlyLimitYuan ?? undefined,
                  unit: "usd" as const,
                },
              ]
            : undefined,
          details: wallet
            ? [
                {
                  id: "kimi-wallet-balance",
                  label: "钱包余额",
                  value: `¥${wallet.balanceYuan.toFixed(2)}`,
                },
              ]
            : undefined,
        };
      }
      if (input.provider === "glm") {
        const config = await readValues(readSettings);
        const entry = config.glm.find((item) => item.id === input.entryId);
        if (!entry) return unavailable({ kind: "no_quota", detail: "该 GLM 订阅已从设置中删除" });
        const result = await fetchGlm(entry);
        if (!result.report.ok) return errorReport(result.report.error, result.httpStatus);
        const windows = glmWindows(result.report);
        const details = result.report.toolCalls
          ? [
              {
                id: "glm-tool-calls",
                label: "月度工具调用",
                value: `${result.report.toolCalls.used}/${result.report.toolCalls.limit} 次`,
              },
            ]
          : undefined;
        if (windows.length === 0 && !details) {
          return unavailable({ kind: "no_quota", detail: "该账号未返回额度窗口" });
        }
        return {
          status: "available",
          planLabel: `GLM ${result.report.level ?? ""} ···${result.report.keyTail}`.trim(),
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
      return {
        status: "available",
        planLabel: result.report.plan ? `Codex ${result.report.plan}` : "Codex",
        windows,
        details: result.report.email
          ? [{ id: "codex-email", label: "账号", value: result.report.email }]
          : undefined,
      };
    },
  };

  server.registerUsageSource(source);
}
