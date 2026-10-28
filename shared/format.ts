/**
 * Human-facing formatting helpers shared by the daemon (usage-source details)
 * and the client (plugin screen). Dependency-free and always rendered in the
 * local timezone — the daemon and the desktop client run on the same machine.
 */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function hhmm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** "2h17m" / "3d4h5m" / "45m" style remaining-time text. */
function formatRemaining(diffMs: number): string {
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days >= 1) return days >= 10 ? `${days}d` : `${days}d${hours}h${minutes}m`;
  if (hours >= 1) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/**
 * Local time plus remaining time for a future timestamp, e.g.
 * "今晚 22:33 · 还剩 2h17m" or "周五 09:00 · 还剩 2d20h13m".
 * Timestamps already in the past collapse to "已到期"; unparseable input
 * returns "" so callers can fall back to a raw value.
 */
export function formatPeriodEndCountdown(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const target = new Date(time);
  const diffMs = time - now;
  if (diffMs <= 0) return "已到期";

  const nowDate = new Date(now);
  const dayDiff = Math.round(
    (new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime() -
      new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()) /
      86_400_000,
  );
  let dayLabel: string;
  if (dayDiff === 0) dayLabel = target.getHours() >= 18 ? "今晚" : "今天";
  else if (dayDiff === 1) dayLabel = "明天";
  else if (dayDiff > 1 && dayDiff < 7) dayLabel = `周${WEEKDAYS[target.getDay()]}`;
  else dayLabel = `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())}`;

  const remaining = formatRemaining(diffMs);
  return `${dayLabel} ${hhmm(target)} · 还剩 ${remaining}`;
}

/** Money with a CNY/USD symbol; other currencies keep their ISO code prefix. */
export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const symbol = code === "CNY" ? "¥" : code === "USD" ? "$" : `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}
