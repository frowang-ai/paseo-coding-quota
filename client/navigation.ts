/**
 * Plugin screens receive only PluginScreenProps, so in-screen navigation back
 * into plugin-owned surfaces goes through this module. The client entry binds
 * the real opener at registration time.
 */
let openSettingsFn: ((id: string) => void) | null = null;

export function bindOpenSettings(open: (id: string) => void): void {
  openSettingsFn = open;
}

export function openQuotaSettings(): void {
  openSettingsFn?.("quota-settings");
}
