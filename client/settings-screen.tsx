import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Fragment, useState, type ReactNode } from "react";
import { Text } from "react-native";
import { quotaSettings } from "../shared/quota";

type AccountEntry = { id: string; label: string; key: string; enabled: boolean };

export function QuotaSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(quotaSettings);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newGLabel, setNewGLabel] = useState("");
  const [newGKey, setNewGKey] = useState("");
  const [newCLabel, setNewCLabel] = useState("");
  const [newCKey, setNewCKey] = useState("");
  const [glmDrafts, setGlmDrafts] = useState<Record<string, string>>({});

  if (settings.status === "loading") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, padding: 16 }}>
        正在加载设置…
      </Text>
    );
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <Text style={{ color: theme.colors.statusDanger, fontSize: 13, padding: 16 }}>
        设置读取失败：{String(settings.error)}
      </Text>
    );
  }

  const { values, revision, save, saving, saveError } = settings;

  function saveEntries(
    provider: "kimi" | "glm" | "commandcode",
    nextEntries: AccountEntry[],
  ): Promise<boolean> {
    if (provider === "kimi") return save({ ...values, kimi: nextEntries }, revision);
    if (provider === "glm") return save({ ...values, glm: nextEntries }, revision);
    return save({ ...values, commandcode: nextEntries }, revision);
  }

  function entryRows(
    provider: "kimi" | "glm" | "commandcode",
    entries: AccountEntry[],
  ): ReactNode {
    return entries.map((entry) => (
      <Fragment key={entry.id}>
        <SettingsAction
          label={`${entry.label}（···${entry.key.slice(-6)}）${entry.enabled === false ? " · 已停用" : ""}`}
          actionLabel="删除"
          disabled={saving}
          onPress={() => {
            void saveEntries(provider, entries.filter((item) => item.id !== entry.id));
          }}
        />
        <SettingsSwitch
          label={`显示 ${entry.label}`}
          hint={entry.enabled === false ? "已停用：配额屏与 Usage 弹窗均不显示，数据保留" : undefined}
          value={entry.enabled !== false}
          disabled={saving}
          onValueChange={(next) => {
            void saveEntries(
              provider,
              entries.map((item) => (item.id === entry.id ? { ...item, enabled: next } : item)),
            );
          }}
        />
      </Fragment>
    ));
  }

  async function addGlm(): Promise<void> {
    const key = newGKey.trim();
    if (!key) return;
    const label = newGLabel.trim() || `GLM ${values.glm.length + 1}`;
    const id = `glm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ok = await save({ ...values, glm: [...values.glm, { id, label, key, enabled: true }] }, revision);
    if (ok) { setNewGLabel(""); setNewGKey(""); }
  }

  async function addKimi(): Promise<void> {
    const key = newKey.trim();
    if (!key) return;
    const label = newLabel.trim() || `Kimi ${values.kimi.length + 1}`;
    const id = `kimi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ok = await save({ ...values, kimi: [...values.kimi, { id, label, key, enabled: true }] }, revision);
    if (ok) {
      setNewLabel("");
      setNewKey("");
    }
  }

  async function addCommandCode(): Promise<void> {
    const key = newCKey.trim();
    if (!key) return;
    const label = newCLabel.trim() || `Command Code ${(values.commandcode ?? []).length + 1}`;
    const id = `cc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ok = await save(
      { ...values, commandcode: [...(values.commandcode ?? []), { id, label, key, enabled: true }] },
      revision,
    );
    if (ok) {
      setNewCLabel("");
      setNewCKey("");
    }
  }

  return (
    <SettingsSection
      title="账号"
      info="Kimi / GLM / Command Code 的 API key 保存在本机 daemon 的设置存储里。每个订阅的标签会作为使用情况弹窗卡片的标题；改名或新增订阅后需重启 Paseo daemon 生效。"
    >
      {saveError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12, paddingBottom: 8 }}>
          保存失败：{String(saveError)}
        </Text>
      ) : null}

      <SettingsCard>
        {entryRows("kimi", values.kimi)}
        {values.kimi.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            还没有添加 Kimi 订阅。每个订阅会单独显示 5 小时 / 每周窗口和加速钱包。
          </Text>
        ) : null}
        <SettingsInput
          label="新订阅标签"
          placeholder="如 699档 / 199档"
          disabled={saving}
          onChangeText={setNewLabel}
        />
        <SettingsInput
          label="新订阅 API Key"
          placeholder="sk-…"
          secureTextEntry
          disabled={saving}
          onChangeText={setNewKey}
        />
        <SettingsAction
          label="添加 Kimi 订阅"
          actionLabel="添加"
          disabled={saving || newKey.trim().length === 0}
          onPress={() => void addKimi()}
        />
      </SettingsCard>

      <SettingsCard>
        {entryRows("glm", values.glm)}
        {values.glm.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            还没有添加 GLM 订阅。每个账号会单独显示 5 小时 / 每周窗口。
          </Text>
        ) : null}
        <SettingsInput label="新 GLM 订阅标签" placeholder="如 GLM Pro" disabled={saving} onChangeText={setNewGLabel} />
        <SettingsInput label="新 GLM API Key" placeholder="sk-…" secureTextEntry disabled={saving} onChangeText={setNewGKey} />
        <SettingsAction label="添加 GLM 订阅" actionLabel="添加" disabled={saving || !newGKey.trim()} onPress={() => void addGlm()} />
      </SettingsCard>

      <SettingsCard>
        {entryRows("commandcode", values.commandcode ?? [])}
        {(values.commandcode ?? []).length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            还没有添加 Command Code 订阅。key 形如 user_…，在 commandcode.ai/studio 生成。
          </Text>
        ) : null}
        <SettingsInput
          label="新 Command Code 订阅标签"
          placeholder="如 goat 档"
          disabled={saving}
          onChangeText={setNewCLabel}
        />
        <SettingsInput
          label="新 Command Code API Key"
          placeholder="user_…"
          secureTextEntry
          disabled={saving}
          onChangeText={setNewCKey}
        />
        <SettingsAction
          label="添加 Command Code 订阅"
          actionLabel="添加"
          disabled={saving || !newCKey.trim()}
          onPress={() => void addCommandCode()}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsSwitch
          label="显示 Codex（ChatGPT）用量"
          hint="自动读取 ~/.codex/auth.json，无需输入"
          value={values.codexEnabled}
          disabled={saving}
          onValueChange={(next) => {
            void save({ ...values, codexEnabled: next }, revision);
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
