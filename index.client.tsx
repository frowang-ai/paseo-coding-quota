import type { PluginClientContext } from "@getpaseo/plugin/client";
import { bindOpenSettings } from "./client/navigation";
import { QuotaScreen } from "./client/quota-screen";
import { QuotaSettingsScreen } from "./client/settings-screen";

export default function contribute(client: PluginClientContext) {
  bindOpenSettings((id) => client.openSettings(id));

  client.addSurface("quota", QuotaScreen);
  client.addSidebarItem({ id: "quota", title: "Coding 额度", icon: "Gauge", surface: "quota" });
  client.addSettingsScreen({
    id: "quota-settings",
    title: "Coding 额度",
    icon: "Gauge",
    Component: QuotaSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-quota",
    title: "打开 Coding 额度",
    icon: "Gauge",
    keywords: ["quota", "kimi", "glm", "codex", "额度"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("quota");
    },
  });

  return () => {};
}
