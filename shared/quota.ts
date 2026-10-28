import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Persisted per-host configuration. Keys live in the daemon-side settings
 * document (ordinary host JSON, not a credential vault — this plugin is meant
 * for a single-user trusted daemon).
 */
/**
 * Per-entry enable flag: disabled entries stay in settings but are hidden from
 * the quota screen and the host Usage modal. Missing (pre-v4 data) means true.
 */
const accountEntry = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  enabled: z.boolean().default(true),
});

export const quotaSettings = defineSettings({
  id: "coding-quota",
  scope: "host",
  version: 4,
  schema: z.object({
    /** Kimi coding-plan subscriptions; each enabled entry is queried and shown separately. */
    kimi: z.array(accountEntry).default([]),
    /** GLM Coding Plan subscriptions; each enabled entry is queried and shown separately. */
    glm: z.array(accountEntry).default([]),
    /** Command Code (commandcode.ai) plan keys; each enabled entry is queried and shown separately. */
    commandcode: z.array(accountEntry).default([]),
    /** Auto-discover Codex credentials from ~/.codex/auth.json (CODEX_HOME honored). */
    codexEnabled: z.boolean().default(true),
  }),
  migrate(values, fromVersion) {
    if (fromVersion === 1) {
      const old = values as { kimi?: unknown; glmKey?: unknown; codexEnabled?: unknown };
      return {
        kimi: withEnabled(old.kimi ?? []),
        glm: typeof old.glmKey === "string" && old.glmKey
          ? [{ id: "glm-default", label: "GLM", key: old.glmKey, enabled: true }]
          : [],
        commandcode: [],
        codexEnabled: old.codexEnabled ?? true,
      };
    }
    if (fromVersion === 2 || fromVersion === 3) {
      const old = values as {
        kimi?: unknown;
        glm?: unknown;
        commandcode?: unknown;
        codexEnabled?: unknown;
      };
      return {
        kimi: withEnabled(old.kimi ?? []),
        glm: withEnabled(old.glm ?? []),
        commandcode: withEnabled(old.commandcode ?? []),
        codexEnabled: old.codexEnabled ?? true,
      };
    }
    return values;
  },
});

/** v4 migration: every pre-v4 entry gains `enabled: true` (data preserved). */
function withEnabled(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    item && typeof item === "object"
      ? { ...(item as Record<string, unknown>), enabled: true }
      : item,
  );
}

export interface QuotaSettingsValues {
  kimi: { id: string; label: string; key: string; enabled: boolean }[];
  glm: { id: string; label: string; key: string; enabled: boolean }[];
  commandcode: { id: string; label: string; key: string; enabled: boolean }[];
  codexEnabled: boolean;
}

/** One usage window: usedRatio in [0,1]; resetAt is an ISO timestamp when known. */
const usageWindow = z.object({
  usedRatio: z.number(),
  resetAt: z.string().nullable(),
});

/**
 * Kimi booster wallet (monthly ¥ budget for wallet-billed plans, e.g. the 199 tier).
 * Mirrors the official Kimi CLI's extraUsage section. All money values are in
 * yuan after conversion — balance comes from 1e6 fixed-point cents, monthly
 * amounts from plain priceInCents.
 */
const kimiWallet = z.object({
  /** Remaining wallet balance in yuan (amountLeft / 1e6 / 100, missing → 0). */
  balanceYuan: z.number(),
  /** Monthly charge limit in yuan when enabled (monthlyChargeLimitEnabled && > 0), else null. */
  monthlyLimitYuan: z.number().nullable(),
  /** Monthly spend so far in yuan (monthlyUsed.priceInCents / 100). */
  monthlyUsedYuan: z.number(),
  currency: z.string(),
});

export const quotaOutputSchema = z.object({
  fetchedAt: z.string(),
  kimi: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      keyTail: z.string(),
      ok: z.boolean(),
      fiveHour: usageWindow.nullable(),
      weekly: usageWindow.nullable(),
      /** Monthly total window (limit_month_total), when the plan reports one. */
      monthly: usageWindow.nullable(),
      wallet: kimiWallet.nullable(),
      error: z.string().nullable(),
    }),
  ),
  glm: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      keyTail: z.string(),
      ok: z.boolean(),
      level: z.string().nullable(),
      fiveHour: usageWindow.nullable(),
      weekly: usageWindow.nullable(),
      toolCalls: z
        .object({ used: z.number(), limit: z.number(), resetAt: z.string().nullable() })
        .nullable(),
      error: z.string().nullable(),
    }),
  ),
  codex: z
    .object({
      ok: z.boolean(),
      email: z.string().nullable(),
      plan: z.string().nullable(),
      windows: z.array(
        z.object({ label: z.string(), usedRatio: z.number(), resetAt: z.string().nullable() }),
      ),
      credits: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
  commandcode: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      keyTail: z.string(),
      ok: z.boolean(),
      /** Account email/user name from /alpha/whoami. */
      user: z.string().nullable(),
      /** Plan id from /alpha/billing/subscriptions (e.g. "individual-goat"). */
      plan: z.string().nullable(),
      /** Subscription status string (active/canceled/…), null when unknown. */
      status: z.string().nullable(),
      /** ISO timestamp the current billing period ends (renewal/reset anchor). */
      periodEnd: z.string().nullable(),
      /** Stripe-style signal: the subscription will not renew after the current period. */
      cancelAtPeriodEnd: z.boolean(),
      /** Scheduled end of service when canceling (ISO/epoch), when the API reports one. */
      cancelAt: z.string().nullable(),
      /** When the cancellation was issued (ISO/epoch), when the API reports one. */
      canceledAt: z.string().nullable(),
      fiveHour: usageWindow.nullable(),
      weekly: usageWindow.nullable(),
      /** Remaining monthly credits in USD (credits.monthlyCredits). */
      monthlyCredits: z.number().nullable(),
      /** Additional purchased credits balance (USD). */
      purchasedCredits: z.number().nullable(),
      error: z.string().nullable(),
    }),
  ),
});

export const quotaRpc = defineRpc({
  name: "quota.get",
  input: z.object({}),
  output: quotaOutputSchema,
});

export type QuotaReport = z.infer<typeof quotaOutputSchema>;
export type KimiReport = QuotaReport["kimi"][number];
export type GlmReport = QuotaReport["glm"][number];
export type CodexReport = NonNullable<QuotaReport["codex"]>;
export type CommandCodeReport = QuotaReport["commandcode"][number];
