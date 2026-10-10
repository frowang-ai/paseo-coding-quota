import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { quotaRpc, type CodexReport, type CommandCodeReport, type GlmReport, type KimiReport } from "../shared/quota";
import { formatMoney, formatPeriodEndCountdown } from "../shared/format";
import { openQuotaSettings } from "./navigation";

const REFRESH_MS = 60_000;

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function barColor(theme: PluginSurfaceProps["theme"], usedRatio: number): string {
  if (usedRatio >= 0.9) return theme.colors.statusDanger;
  if (usedRatio >= 0.7) return theme.colors.statusWarning;
  return theme.colors.accent;
}

function formatReset(resetAt: string | null): string {
  if (!resetAt) return "";
  const time = new Date(resetAt).getTime();
  if (!Number.isFinite(time)) return "";
  const diffMs = time - Date.now();
  if (diffMs <= 0) return "已重置";
  const minutes = Math.round(diffMs / 60_000);
  const date = new Date(time);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (minutes < 90) return `${minutes} 分钟后重置（${hhmm}）`;
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return `今天 ${hhmm} 重置`;
  const md = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${md} ${hhmm} 重置`;
}

function ProgressBar({
  theme,
  usedRatio,
}: {
  theme: PluginSurfaceProps["theme"];
  usedRatio: number;
}) {
  const width = Math.min(100, Math.max(0, Math.round(usedRatio * 100)));
  return (
    <View
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: 6,
          borderRadius: 3,
          width: `${width}%`,
          backgroundColor: barColor(theme, usedRatio),
        }}
      />
    </View>
  );
}

function WindowRow({
  theme,
  label,
  usedRatio,
  resetAt,
}: {
  theme: PluginSurfaceProps["theme"];
  label: string;
  usedRatio: number;
  resetAt: string | null;
}) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          剩余 {pct(1 - usedRatio)} · 已用 {pct(usedRatio)}
        </Text>
      </View>
      <ProgressBar theme={theme} usedRatio={usedRatio} />
      {resetAt ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{formatReset(resetAt)}</Text>
      ) : null}
    </View>
  );
}

function Card({
  theme,
  title,
  subtitle,
  children,
}: {
  theme: PluginSurfaceProps["theme"];
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        padding: 14,
        gap: 12,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        {subtitle ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{subtitle}</Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function ErrorText({ theme, message }: { theme: PluginSurfaceProps["theme"]; message: string }) {
  return (
    <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{message}</Text>
  );
}

function WalletRow({
  theme,
  label,
  value,
  danger = false,
}: {
  theme: PluginSurfaceProps["theme"];
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
      <Text style={{ color: danger ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: danger ? theme.colors.statusDanger : theme.colors.foreground, fontSize: 13 }}>{value}</Text>
    </View>
  );
}

function KimiCard({ theme, report }: { theme: PluginSurfaceProps["theme"]; report: KimiReport }) {
  const wallet = report.wallet;
  const walletRatio =
    wallet && wallet.monthlyLimitYuan
      ? Math.min(1, Math.max(0, wallet.monthlyUsedYuan / wallet.monthlyLimitYuan))
      : null;
  return (
    <Card theme={theme} title={report.label} subtitle={`Kimi 订阅 ···${report.keyTail}`}>
      {report.ok ? (
        <>
          {report.fiveHour ? (
            <WindowRow theme={theme} label="5 小时窗口" usedRatio={report.fiveHour.usedRatio} resetAt={report.fiveHour.resetAt} />
          ) : null}
          {report.weekly ? (
            <WindowRow theme={theme} label="每周窗口" usedRatio={report.weekly.usedRatio} resetAt={report.weekly.resetAt} />
          ) : null}
          {report.monthly ? (
            <WindowRow theme={theme} label="每月窗口" usedRatio={report.monthly.usedRatio} resetAt={report.monthly.resetAt} />
          ) : null}
          {wallet ? (
            <View style={{ gap: 6 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>月度钱包</Text>
              {walletRatio !== null ? <ProgressBar theme={theme} usedRatio={walletRatio} /> : null}
              <WalletRow theme={theme} label="本月已用" value={formatMoney(wallet.monthlyUsedYuan, wallet.currency)} />
              <WalletRow
                theme={theme}
                label="月度上限"
                value={wallet.monthlyLimitYuan ? formatMoney(wallet.monthlyLimitYuan, wallet.currency) : "不限"}
              />
              <WalletRow theme={theme} label="钱包余额" value={formatMoney(wallet.balanceYuan, wallet.currency)} />
            </View>
          ) : null}
        </>
      ) : (
        <ErrorText theme={theme} message={report.error ?? "查询失败"} />
      )}
    </Card>
  );
}

function GlmCard({ theme, report }: { theme: PluginSurfaceProps["theme"]; report: GlmReport }) {
  return (
    <Card
      theme={theme}
      title={report.label}
      subtitle={`GLM Coding Plan ···${report.keyTail}`}
    >
      {report.ok ? (
        <>
          {report.fiveHour ? (
            <WindowRow theme={theme} label="5 小时 token 窗口" usedRatio={report.fiveHour.usedRatio} resetAt={report.fiveHour.resetAt} />
          ) : null}
          {report.weekly ? (
            <WindowRow theme={theme} label="每周 token 窗口" usedRatio={report.weekly.usedRatio} resetAt={report.weekly.resetAt} />
          ) : null}
          {report.toolCalls ? (
            <View style={{ gap: 2 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>月度工具调用</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                {report.toolCalls.used}/{report.toolCalls.limit} 次 ·{" "}
                {formatReset(report.toolCalls.resetAt)}
              </Text>
            </View>
          ) : null}
        </>
      ) : (
        <ErrorText theme={theme} message={report.error ?? "查询失败"} />
      )}
    </Card>
  );
}

function CodexCard({ theme, report }: { theme: PluginSurfaceProps["theme"]; report: CodexReport }) {
  const subtitle = [report.plan ? `套餐 ${report.plan}` : null, report.email]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card theme={theme} title="Codex（ChatGPT）" subtitle={subtitle || undefined}>
      {report.ok ? (
        <>
          {report.windows.map((window, index) => (
            <WindowRow
              key={`${window.label}-${index}`}
              theme={theme}
              label={window.label}
              usedRatio={window.usedRatio}
              resetAt={window.resetAt}
            />
          ))}
          {report.credits && report.credits !== "0" ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              Credits 余额 {report.credits}
            </Text>
          ) : null}
        </>
      ) : (
        <ErrorText theme={theme} message={report.error ?? "查询失败"} />
      )}
    </Card>
  );
}

function CommandCodeCard({ theme, report }: { theme: PluginSurfaceProps["theme"]; report: CommandCodeReport }) {
  const subtitle = [
    report.plan ? `套餐 ${report.plan}` : null,
    report.user,
    `···${report.keyTail}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const cancelPending =
    report.cancelAtPeriodEnd || report.cancelAt !== null || report.canceledAt !== null;
  const endIso = report.cancelAt ?? report.periodEnd;
  return (
    <Card theme={theme} title={report.label} subtitle={subtitle || undefined}>
      {report.ok ? (
        <>
          {report.fiveHour ? (
            <WindowRow theme={theme} label="5 小时窗口" usedRatio={report.fiveHour.usedRatio} resetAt={report.fiveHour.resetAt} />
          ) : null}
          {report.weekly ? (
            <WindowRow theme={theme} label="每周窗口" usedRatio={report.weekly.usedRatio} resetAt={report.weekly.resetAt} />
          ) : null}
          {report.monthlyCredits !== null || (report.purchasedCredits ?? 0) > 0 || endIso !== null || report.canceledAt !== null ? (
            <View style={{ gap: 6 }}>
              {report.monthlyCredits !== null ? (
                <WalletRow theme={theme} label="月度剩余额度" value={`$${report.monthlyCredits.toFixed(2)}`} />
              ) : null}
              {(report.purchasedCredits ?? 0) > 0 ? (
                <WalletRow theme={theme} label="已购额度余额" value={`$${(report.purchasedCredits ?? 0).toFixed(2)}`} />
              ) : null}
              {endIso ? (
                <WalletRow
                  theme={theme}
                  danger={cancelPending}
                  label={cancelPending ? "到期（不续订）" : "账期截止"}
                  value={formatPeriodEndCountdown(endIso) || endIso.slice(0, 10)}
                />
              ) : null}
              {report.status && report.status !== "active" ? (
                <WalletRow theme={theme} label="订阅状态" value={report.status} />
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        <ErrorText theme={theme} message={report.error ?? "查询失败"} />
      )}
    </Card>
  );
}

function EmptyState({ theme, onOpenSettings }: { theme: PluginSurfaceProps["theme"]; onOpenSettings: () => void }) {
  return (
    <Card theme={theme} title="还没有配置账号">
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
        在设置里添加 Kimi / GLM / Command Code API key；Codex 会自动读取 ~/.codex/auth.json。
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onOpenSettings}
        style={{
          alignSelf: "flex-start",
          paddingVertical: 8,
          paddingHorizontal: 14,
          borderRadius: 8,
          backgroundColor: theme.colors.accent,
        }}
      >
        <Text style={{ color: theme.colors.accentForeground, fontSize: 13 }}>打开设置</Text>
      </Pressable>
    </Card>
  );
}

export function QuotaScreen({ theme, layout }: PluginSurfaceProps) {
  const getQuota = useRpc(quotaRpc);
  const query = useQuery({
    queryKey: ["codingQuota"],
    queryFn: () => getQuota({}),
    refetchInterval: REFRESH_MS,
  });

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 10 : 14,
        backgroundColor: theme.colors.surface0,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      refresh: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      refreshing: { color: theme.colors.accentForeground, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  const data = query.data;
  const empty =
    data && data.kimi.length === 0 && data.glm.length === 0 && data.codex === null && (data.commandcode ?? []).length === 0;
  const updatedAt = data ? new Date(data.fetchedAt) : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: layout.compact ? 10 : 14, paddingBottom: 32 }}>
      <View style={styles.header}>
        <Text style={styles.title}>Coding 额度</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="刷新额度"
          style={styles.refresh}
          disabled={query.isFetching}
          onPress={() => void query.refetch()}
        >
          <Text style={{ ...styles.refreshing, color: theme.colors.foreground }}>
            {query.isFetching ? "刷新中…" : "刷新"}
          </Text>
        </Pressable>
      </View>
      {updatedAt ? (
        <Text style={styles.meta}>
          更新于 {String(updatedAt.getHours()).padStart(2, "0")}:{String(updatedAt.getMinutes()).padStart(2, "0")}:{String(updatedAt.getSeconds()).padStart(2, "0")}
          {query.isError ? " · 上次刷新失败，显示缓存数据" : ""}
        </Text>
      ) : null}

      {query.isError && !data ? (
        <ErrorText theme={theme} message={query.error instanceof Error ? query.error.message : String(query.error)} />
      ) : null}

      {empty ? <EmptyState theme={theme} onOpenSettings={openQuotaSettings} /> : null}

      {data?.kimi.map((report) => (
        <KimiCard key={report.id} theme={theme} report={report} />
      ))}
      {data?.glm.map((report) => (
        <GlmCard key={report.id} theme={theme} report={report} />
      ))}
      {data?.codex ? <CodexCard theme={theme} report={data.codex} /> : null}
      {data?.commandcode.map((report) => (
        <CommandCodeCard key={report.id} theme={theme} report={report} />
      ))}
    </ScrollView>
  );
}
