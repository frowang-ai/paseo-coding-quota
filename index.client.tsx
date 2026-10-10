import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { bindOpenSettings } from "./client/navigation";
import { QuotaScreen } from "./client/quota-screen";
import { QuotaSettingsScreen } from "./client/settings-screen";

function QuotaSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="Gauge"
      label="Coding 额度"
      active={currentScreen?.screenId === "quota"}
      onPress={() => openScreen({ screenId: "quota" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  bindOpenSettings((id) => client.openSettings(id));

  client.addScreen({ id: "quota", title: "Coding 额度", Component: QuotaScreen });
  client.addSidebarFooterItem({ id: "quota", title: "Coding 额度", Component: QuotaSidebarItem });
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
    onSelect({ openScreen }) {
      openScreen({ screenId: "quota" });
    },
  });

  return () => {};
}
