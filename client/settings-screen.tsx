import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { quotaSettings } from "../shared/quota";

export function QuotaSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(quotaSettings);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  // null = untouched, use the stored value; otherwise the in-progress draft
  const [glmDraft, setGlmDraft] = useState<string | null>(null);

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

  async function addKimi(): Promise<void> {
    const key = newKey.trim();
    if (!key) return;
    const label = newLabel.trim() || `Kimi ${values.kimi.length + 1}`;
    const id = `kimi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const ok = await save({ ...values, kimi: [...values.kimi, { id, label, key }] }, revision);
    if (ok) {
      setNewLabel("");
      setNewKey("");
    }
  }

  return (
    <SettingsSection title="账号" info="Kimi / GLM 的 API key 保存在本机 daemon 的设置存储里">
      {saveError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12, paddingBottom: 8 }}>
          保存失败：{String(saveError)}
        </Text>
      ) : null}

      <SettingsCard>
        {values.kimi.map((entry) => (
          <SettingsAction
            key={entry.id}
            label={`${entry.label}（···${entry.key.slice(-6)}）`}
            actionLabel="删除"
            disabled={saving}
            onPress={() => {
              void save(
                { ...values, kimi: values.kimi.filter((item) => item.id !== entry.id) },
                revision,
              );
            }}
          />
        ))}
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
        <SettingsInput
          label="GLM Coding Plan API Key"
          placeholder="留空表示不显示 GLM"
          secureTextEntry
          initialValue={values.glmKey}
          disabled={saving}
          onChangeText={(text) => setGlmDraft(text)}
        />
        <SettingsAction
          label={values.glmKey ? "更新 GLM Key" : "保存 GLM Key"}
          actionLabel="保存"
          disabled={saving}
          onPress={() => {
            void save({ ...values, glmKey: (glmDraft ?? values.glmKey).trim() }, revision);
          }}
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
