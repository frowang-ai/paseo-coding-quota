import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Persisted per-host configuration. Keys live in the daemon-side settings
 * document (ordinary host JSON, not a credential vault — this plugin is meant
 * for a single-user trusted daemon).
 */
export const quotaSettings = defineSettings({
  id: "coding-quota",
  scope: "host",
  version: 2,
  schema: z.object({
    /** Kimi coding-plan subscriptions; each entry is queried and shown separately. */
    kimi: z.array(z.object({ id: z.string(), label: z.string(), key: z.string() })).default([]),
    /** GLM Coding Plan subscriptions; each entry is queried and shown separately. */
    glm: z.array(z.object({ id: z.string(), label: z.string(), key: z.string() })).default([]),
    /** Auto-discover Codex credentials from ~/.codex/auth.json (CODEX_HOME honored). */
    codexEnabled: z.boolean().default(true),
  }),
  migrate(values, fromVersion) {
    if (fromVersion === 1) {
      const old = values as { kimi?: unknown; glmKey?: unknown; codexEnabled?: unknown };
      return {
        kimi: old.kimi ?? [],
        glm: typeof old.glmKey === "string" && old.glmKey
          ? [{ id: "glm-default", label: "GLM", key: old.glmKey }]
          : [],
        codexEnabled: old.codexEnabled ?? true,
      };
    }
    return values;
  },
});

export interface QuotaSettingsValues {
  kimi: { id: string; label: string; key: string }[];
  glm: { id: string; label: string; key: string }[];
  codexEnabled: boolean;
}

/** One usage window: usedRatio in [0,1]; resetAt is an ISO timestamp when known. */
const usageWindow = z.object({
  usedRatio: z.number(),
  resetAt: z.string().nullable(),
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
      walletLeftRatio: z.number().nullable(),
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
