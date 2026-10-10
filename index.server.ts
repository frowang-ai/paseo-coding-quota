import type { PluginServerContext } from "@getpaseo/plugin/server";
import { quotaRpc, quotaSettings, type QuotaSettingsValues } from "./shared/quota";
import { getQuotaReport } from "./server/quota";
import { registerCodingQuotaUsageSource } from "./server/usage-source";

const DEFAULTS: QuotaSettingsValues = { kimi: [], glm: [], commandcode: [], codexEnabled: true };

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(quotaSettings);

  const readSettings = async (): Promise<QuotaSettingsValues> => {
    const state = await settings.read().catch(() => null);
    return state && state.status === "ready" ? state.values : DEFAULTS;
  };

  server.handle(quotaRpc, async () => {
    return getQuotaReport(readSettings);
  });

  // Paseo 0.11+: surface the same accounts in the built-in usage UI
  // (sidebar footer card + Usage modal).
  registerCodingQuotaUsageSource(server, readSettings);

  console.log("[coding-quota] ready");
  return () => {};
}
