import type { PluginServerContext } from "@getpaseo/plugin/server";
import { quotaRpc, quotaSettings, type QuotaSettingsValues } from "./shared/quota";
import { getQuotaReport } from "./server/quota";

const DEFAULTS: QuotaSettingsValues = { kimi: [], glm: [], codexEnabled: true };

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(quotaSettings);

  server.handle(quotaRpc, async () => {
    const state = await settings.read().catch(() => null);
    const values: QuotaSettingsValues = state && state.status === "ready" ? state.values : DEFAULTS;
    return getQuotaReport(async () => values);
  });

  console.log("[coding-quota] ready");
  return () => {};
}
