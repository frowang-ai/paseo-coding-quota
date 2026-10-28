import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexWindowLabel, glmWindowLabel, getQuotaReport, mapCodexBody, mapCommandCodeCredits, mapGlmBody, mapKimiBody } from "../server/quota";
import { readBootSettings, registerCodingQuotaUsageSource, windowResetDetail } from "../server/usage-source";
import { formatPeriodEndCountdown } from "../shared/format";

/** Real response shape from https://api.kimi.com/coding/v1/usages (2026-10-05, ids sanitized). */
const KIMI_BODY = {
  usage: { limit: "100", remaining: "100", resetTime: "2026-10-11T12:15:46.930934Z" },
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", remaining: "100", resetTime: "2026-10-05T12:15:46.930934Z" },
    },
  ],
  booster_wallet: {
    id: "sanitized",
    balance: {
      amount: "60000000000",
      amountLeft: "15673479600",
      unit: "UNIT_CURRENCY",
    },
    status: "STATUS_ACTIVE",
    monthlyUsed: { currency: "CNY", priceInCents: "40000" },
  },
  usages: {
    limit_5h: { used_ratio: 0.42, reset_time: "2026-10-05T12:15:46Z" },
    limit_7d: { used_ratio: 0.000011, reset_time: "2026-10-11T12:15:46Z" },
  },
};

/**
 * Real response shape for a wallet-billed 199 plan whose monthly budget is
 * exhausted: amountLeft is omitted entirely, monthlyUsed equals the ¥700
 * fixed-point balance amount, and the 5h/7d windows report 0 (they do not
 * apply to this billing mode). Captured 2026-10-07.
 */
const KIMI_BODY_WALLET_EXHAUSTED = {
  usage: { limit: "100", remaining: "100", resetTime: "2026-10-11T12:15:46.930934Z" },
  booster_wallet: {
    id: "sanitized",
    balance: {
      id: "sanitized",
      feature: "FEATURE_OMNI",
      type: "BOOSTER",
      amount: "70000000000",
      unit: "UNIT_CURRENCY",
      periodStart: "2026-09-21T10:28:28.592313Z",
      periodEnd: "2126-09-21T10:28:29.592313Z",
      updateTime: "2026-10-06T17:04:15.459898Z",
    },
    status: "STATUS_ACTIVE",
    allowTopup: true,
    monthlyChargeLimit: { currency: "CNY", priceInCents: "0" },
    monthlyUsed: { currency: "CNY", priceInCents: "70000" },
  },
  usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-10-07T04:15:46Z" },
    limit_7d: { used_ratio: 6e-05, reset_time: "2026-10-11T12:15:46Z" },
  },
};

/** Real response shape from https://open.bigmodel.cn/api/monitor/usage/quota/limit (2026-10-05). */
const GLM_BODY = {
  code: 200,
  msg: "操作成功",
  data: {
    limits: [
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 1000,
        currentValue: 242,
        remaining: 758,
        percentage: 24,
        nextResetTime: 1792931211983,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 11,
        nextResetTime: 1791206209602,
      },
      {
        type: "TOKENS_LIMIT",
        unit: 6,
        number: 1,
        percentage: 52,
        nextResetTime: 1791695813984,
      },
    ],
    level: "pro",
  },
  success: true,
};

/** Real response shape from https://chatgpt.com/backend-api/wham/usage (2026-10-05, ids sanitized). */
const CODEX_BODY = {
  user_id: "user-sanitized",
  account_id: "sanitized-uuid",
  email: "user@example.com",
  plan_type: "prolite",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 3,
      limit_window_seconds: 604800,
      reset_after_seconds: 528673,
      reset_at: 1791722708,
    },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
};

/** Real response shapes from https://api.commandcode.ai/alpha/* (2026-10-10, ids sanitized). */
const CC_CREDITS_BODY = {
  credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 30.2856630512, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.2683153712, cap: 14, exceeded: false, resetAt: 1791634839892 },
    weekly: { used: 22.4347120941, cap: 35, exceeded: false, resetAt: 1791787296411 },
  },
  sandboxAccess: true,
  sandboxMinutes: { usedMinutes: 0, limitMinutes: 0, overageUsd: 0, resetAt: 1793491200000 },
};
const CC_SUB_BODY = {
  success: true,
  data: {
    id: "sub_sanitized",
    status: "active",
    userId: "sanitized-uuid",
    planId: "individual-goat",
    currentPeriodEnd: "2026-10-10T14:33:18.000Z",
  },
};
/** Same shape with Stripe-style cancellation signals set (period-end cancel). */
const CC_SUB_CANCELED_BODY = {
  success: true,
  data: {
    ...CC_SUB_BODY.data,
    cancelAtPeriodEnd: true,
    cancelAt: "2026-10-10T14:33:18.000Z",
    canceledAt: "2026-10-09T08:00:00.000Z",
  },
};
const CC_WHOAMI_BODY = {
  success: true,
  user: { id: "sanitized-uuid", name: "tester", email: "tester@example.com", userName: "tester" },
  org: null,
};

describe("mapKimiBody", () => {
  it("maps 5h/7d windows and the booster wallet", () => {
    const mapped = mapKimiBody(KIMI_BODY);
    expect(mapped.fiveHour).toEqual({ usedRatio: 0.42, resetAt: "2026-10-05T12:15:46Z" });
    expect(mapped.weekly).toEqual({ usedRatio: 0.000011, resetAt: "2026-10-11T12:15:46Z" });
    expect(mapped.monthly).toBeNull();
    // amountLeft = 15673479600 fixed-point cents → ¥156.73; monthlyUsed 40000 cents → ¥400
    expect(mapped.wallet?.balanceYuan).toBeCloseTo(156.734796);
    expect(mapped.wallet?.monthlyLimitYuan).toBeNull();
    expect(mapped.wallet?.monthlyUsedYuan).toBe(400);
    expect(mapped.wallet?.currency).toBe("CNY");
  });

  it("treats a missing amountLeft as an empty wallet (exhausted 199 plan)", () => {
    const mapped = mapKimiBody(KIMI_BODY_WALLET_EXHAUSTED);
    expect(mapped.wallet).toEqual({
      balanceYuan: 0,
      monthlyLimitYuan: null,
      monthlyUsedYuan: 700,
      currency: "CNY",
    });
  });

  it("maps limit_month_total when the plan reports one", () => {
    const mapped = mapKimiBody({
      usages: {
        limit_5h: { used_ratio: 0.1, reset_time: "2026-10-05T12:15:46Z" },
        limit_month_total: { used_ratio: 0.5, reset_time: "2026-11-01T00:00:00Z" },
      },
    });
    expect(mapped.monthly).toEqual({ usedRatio: 0.5, resetAt: "2026-11-01T00:00:00Z" });
  });

  it("uses the monthly charge limit as the wallet ceiling when enabled", () => {
    const mapped = mapKimiBody({
      booster_wallet: {
        balance: { amount: "70000000000", amountLeft: "10000000000" },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { currency: "CNY", priceInCents: "20000" },
        monthlyUsed: { currency: "CNY", priceInCents: "5000" },
      },
      usages: {},
    });
    expect(mapped.wallet?.monthlyLimitYuan).toBe(200);
    expect(mapped.wallet?.monthlyUsedYuan).toBe(50);
    expect(mapped.wallet?.balanceYuan).toBe(100);
  });

  it("tolerates missing sections", () => {
    const mapped = mapKimiBody({ usages: {} });
    expect(mapped.fiveHour).toBeNull();
    expect(mapped.weekly).toBeNull();
    expect(mapped.monthly).toBeNull();
    expect(mapped.wallet).toBeNull();
  });
});

describe("mapGlmBody", () => {
  it("maps the 5h token window, weekly token window, and monthly tool calls", () => {
    const mapped = mapGlmBody(GLM_BODY);
    expect(mapped.level).toBe("pro");
    expect(mapped.fiveHour).toEqual({ usedRatio: 0.11, resetAt: new Date(1791206209602).toISOString() });
    expect(mapped.weekly).toEqual({ usedRatio: 0.52, resetAt: new Date(1791695813984).toISOString() });
    expect(mapped.toolCalls).toEqual({
      used: 242,
      limit: 1000,
      resetAt: new Date(1792931211983).toISOString(),
    });
  });

  it("labels windows in Chinese units", () => {
    expect(glmWindowLabel(3, 5)).toBe("5 小时");
    expect(glmWindowLabel(6, 1)).toBe("每周");
    expect(glmWindowLabel(5, 1)).toBe("每月");
  });
});

describe("mapCommandCodeCredits", () => {
  it("maps 5h/weekly windows, plan metadata, and credits balance", () => {
    const mapped = mapCommandCodeCredits(CC_CREDITS_BODY, CC_SUB_BODY, CC_WHOAMI_BODY);
    expect(mapped.plan).toBe("individual-goat");
    expect(mapped.status).toBe("active");
    expect(mapped.periodEnd).toBe("2026-10-10T14:33:18.000Z");
    expect(mapped.user).toBe("tester@example.com");
    expect(mapped.fiveHour?.usedRatio).toBeCloseTo(0.2683153712 / 14);
    expect(mapped.fiveHour?.resetAt).toBe(new Date(1791634839892).toISOString());
    expect(mapped.weekly?.usedRatio).toBeCloseTo(22.4347120941 / 35);
    expect(mapped.weekly?.resetAt).toBe(new Date(1791787296411).toISOString());
    expect(mapped.monthlyCredits).toBeCloseTo(30.2856630512);
    expect(mapped.purchasedCredits).toBe(0);
  });

  it("survives missing subscription/whoami (key still valid, enrichment failed)", () => {
    const mapped = mapCommandCodeCredits(CC_CREDITS_BODY, null, null);
    expect(mapped.plan).toBeNull();
    expect(mapped.user).toBeNull();
    expect(mapped.fiveHour?.usedRatio).toBeCloseTo(0.2683153712 / 14);
    expect(mapped.monthlyCredits).toBeCloseTo(30.2856630512);
  });

  it("defaults cancellation signals to false/null when the API omits them", () => {
    const mapped = mapCommandCodeCredits(CC_CREDITS_BODY, CC_SUB_BODY, CC_WHOAMI_BODY);
    expect(mapped.cancelAtPeriodEnd).toBe(false);
    expect(mapped.cancelAt).toBeNull();
    expect(mapped.canceledAt).toBeNull();
  });

  it("extracts Stripe-style cancellation signals", () => {
    const mapped = mapCommandCodeCredits(CC_CREDITS_BODY, CC_SUB_CANCELED_BODY, CC_WHOAMI_BODY);
    expect(mapped.cancelAtPeriodEnd).toBe(true);
    expect(mapped.cancelAt).toBe("2026-10-10T14:33:18.000Z");
    expect(mapped.canceledAt).toBe("2026-10-09T08:00:00.000Z");
  });

  it("accepts epoch-number cancel timestamps (seconds or milliseconds)", () => {
    const seconds = mapCommandCodeCredits(
      CC_CREDITS_BODY,
      { success: true, data: { ...CC_SUB_BODY.data, cancelAt: 1791745998 } },
      null,
    );
    expect(seconds.cancelAt).toBe(new Date(1791745998000).toISOString());
    const millis = mapCommandCodeCredits(
      CC_CREDITS_BODY,
      { success: true, data: { ...CC_SUB_BODY.data, canceledAt: 1791655200000 } },
      null,
    );
    expect(millis.canceledAt).toBe(new Date(1791655200000).toISOString());
  });

  it("handles plans without windowLimits", () => {
    const mapped = mapCommandCodeCredits({ credits: { monthlyCredits: 5, purchasedCredits: 2 } }, null, null);
    expect(mapped.fiveHour).toBeNull();
    expect(mapped.weekly).toBeNull();
    expect(mapped.monthlyCredits).toBe(5);
    expect(mapped.purchasedCredits).toBe(2);
  });
});

describe("mapCodexBody", () => {
  it("maps the primary weekly window from a ProLite plan", () => {
    const mapped = mapCodexBody(CODEX_BODY);
    expect(mapped.plan).toBe("prolite");
    expect(mapped.email).toBe("user@example.com");
    expect(mapped.windows).toEqual([
      { label: "每周窗口", usedRatio: 0.03, resetAt: new Date(1791722708 * 1000).toISOString() },
    ]);
    expect(mapped.credits).toBe("0");
  });

  it("maps both windows when a secondary window exists", () => {
    const mapped = mapCodexBody({
      ...CODEX_BODY,
      rate_limit: {
        primary_window: { used_percent: 80, limit_window_seconds: 300, reset_at: 1791722708 },
        secondary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1791722708 },
      },
    });
    expect(mapped.windows).toEqual([
      { label: "5 小时窗口", usedRatio: 0.8, resetAt: new Date(1791722708 * 1000).toISOString() },
      { label: "每周窗口", usedRatio: 0.25, resetAt: new Date(1791722708 * 1000).toISOString() },
    ]);
  });

  it("labels unusual durations generically", () => {
    expect(codexWindowLabel(300)).toBe("5 小时窗口");
    expect(codexWindowLabel(604800)).toBe("每周窗口");
    expect(codexWindowLabel(172800)).toBe("2 天窗口");
    expect(codexWindowLabel(7200)).toBe("2 小时窗口");
    expect(codexWindowLabel(undefined)).toBe("用量窗口");
  });
});

describe("formatPeriodEndCountdown", () => {
  // 2026-10-10 12:00 local time; targets are built in local time too, so the
  // expectations hold regardless of the machine's timezone.
  const now = new Date(2026, 9, 10, 12, 0).getTime();
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();

  it("marks same-evening ends as 今晚", () => {
    expect(formatPeriodEndCountdown(at(2026, 9, 10, 22, 33), now)).toBe("今晚 22:33 · 还剩 10h33m");
  });

  it("marks same-day daytime ends as 今天", () => {
    expect(formatPeriodEndCountdown(at(2026, 9, 10, 14, 5), now)).toBe("今天 14:05 · 还剩 2h5m");
  });

  it("marks tomorrow ends as 明天", () => {
    expect(formatPeriodEndCountdown(at(2026, 9, 11, 9, 0), now)).toBe("明天 09:00 · 还剩 21h0m");
  });

  it("uses the weekday within a week", () => {
    const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(2026, 9, 13).getDay()];
    expect(formatPeriodEndCountdown(at(2026, 9, 13, 8, 30), now)).toBe(`周${weekday} 08:30 · 还剩 2d20h30m`);
  });

  it("falls back to MM-DD beyond a week", () => {
    expect(formatPeriodEndCountdown(at(2027, 0, 5, 10, 0), now)).toBe("01-05 10:00 · 还剩 86d");
  });

  it("collapses past timestamps to 已到期", () => {
    expect(formatPeriodEndCountdown(at(2026, 9, 10, 11, 59), now)).toBe("已到期");
  });

  it("returns empty for invalid input", () => {
    expect(formatPeriodEndCountdown("not-a-date", now)).toBe("");
  });
});

describe("windowResetDetail", () => {
  const now = new Date(2026, 9, 10, 12, 0).getTime();
  const future = new Date(2026, 9, 10, 17, 30).toISOString();

  it("builds a reset detail row with an exact countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      expect(windowResetDetail("kimi-5h-reset", "5 小时窗口", future)).toEqual({
        id: "kimi-5h-reset",
        label: "5 小时窗口重置",
        value: "今天 17:30 · 还剩 5h30m",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when the window has no usable reset time", () => {
    expect(windowResetDetail("kimi-5h-reset", "5 小时窗口", null)).toBeNull();
    expect(windowResetDetail("kimi-5h-reset", "5 小时窗口", "not-a-date")).toBeNull();
  });
});

describe("readBootSettings", () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-quota-boot-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string): string => join(dir, name);

  it("parses the daemon settings file with entry labels", () => {
    writeFileSync(
      file("ok.json"),
      JSON.stringify({
        version: 3,
        kimi: [{ id: "kimi_a", label: "kimi-me-699", key: "sk-a" }],
        glm: [{ id: "glm-default", label: "GLM", key: "sk-g" }],
        commandcode: [{ id: "cc_goat_default", label: "CmdCode goat", key: "user_c" }],
        codexEnabled: true,
      }),
    );
    expect(readBootSettings(file("ok.json"))).toEqual({
      kimi: [{ id: "kimi_a", label: "kimi-me-699", key: "sk-a", enabled: true }],
      glm: [{ id: "glm-default", label: "GLM", key: "sk-g", enabled: true }],
      commandcode: [{ id: "cc_goat_default", label: "CmdCode goat", key: "user_c", enabled: true }],
      codexEnabled: true,
    });
  });

  it("accepts the { values } envelope shape", () => {
    writeFileSync(
      file("envelope.json"),
      JSON.stringify({ values: { kimi: [{ id: "k", label: "L", key: "K" }], glm: [], commandcode: [] } }),
    );
    expect(readBootSettings(file("envelope.json"))?.kimi).toEqual([{ id: "k", label: "L", key: "K", enabled: true }]);
  });

  it("drops malformed entries and defaults codexEnabled to true", () => {
    writeFileSync(
      file("partial.json"),
      JSON.stringify({ kimi: [{ id: "ok", label: 5, key: "k" }, { nope: true }, "junk"], glm: [] }),
    );
    const boot = readBootSettings(file("partial.json"));
    expect(boot?.kimi).toEqual([{ id: "ok", label: "", key: "k", enabled: true }]);
    expect(boot?.codexEnabled).toBe(true);
  });

  it("preserves enabled: false from the settings file", () => {
    writeFileSync(
      file("disabled.json"),
      JSON.stringify({ kimi: [{ id: "k", label: "L", key: "K", enabled: false }] }),
    );
    expect(readBootSettings(file("disabled.json"))?.kimi).toEqual([
      { id: "k", label: "L", key: "K", enabled: false },
    ]);
  });

  it("returns null for missing, garbage, or entry-less files", () => {
    expect(readBootSettings(file("missing.json"))).toBeNull();
    writeFileSync(file("garbage.json"), "{not json");
    expect(readBootSettings(file("garbage.json"))).toBeNull();
    writeFileSync(file("empty.json"), JSON.stringify({ kimi: [], glm: [], commandcode: [] }));
    expect(readBootSettings(file("empty.json"))).toBeNull();
  });
});

describe("registerCodingQuotaUsageSource", () => {
  const bootDir = mkdtempSync(join(tmpdir(), "coding-quota-home-"));
  const settingsFile = join(bootDir, "plugin-settings", "paseo-coding-quota", "coding-quota.json");
  const bootConfig = {
    kimi: [
      { id: "kimi_a", label: "kimi-me-699", key: "sk-a", enabled: true },
      { id: "kimi_b", label: "kimi-2-199", key: "sk-b", enabled: true },
    ],
    glm: [{ id: "glm-default", label: "GLM", key: "sk-g", enabled: true }],
    commandcode: [{ id: "cc_goat_default", label: "CmdCode goat", key: "user_c", enabled: true }],
    codexEnabled: false,
  };
  const previousPaseoHome = process.env.PASEO_HOME;

  afterAll(() => {
    process.env.PASEO_HOME = previousPaseoHome;
    rmSync(bootDir, { recursive: true, force: true });
  });

  function stubServer() {
    const sources: { id: string; label: string; discover: unknown }[] = [];
    const server = {
      registerUsageSource: (source: { id: string; label: string; discover: unknown }) => {
        sources.push(source);
      },
    };
    return { server, sources };
  }

  it("registers every source synchronously before contribute returns (ready-snapshot contract)", async () => {
    process.env.PASEO_HOME = bootDir;
    mkdirSync(join(bootDir, "plugin-settings", "paseo-coding-quota"), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(bootConfig));

    const { server, sources } = stubServer();
    registerCodingQuotaUsageSource(server as never, async () => bootConfig);

    // No async continuation may be pending: the list must be complete right now.
    expect(sources).toHaveLength(8);
    expect(sources.map((s) => s.label)).toEqual([
      "kimi-me-699",
      "kimi-2-199",
      "Kimi（新订阅）",
      "GLM",
      "GLM（新订阅）",
      "CmdCode goat",
      "CmdCode（新订阅）",
      "Codex（ChatGPT）",
    ]);
    const ids = sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9._-]*$/);

    // Per-account discover gates on the live settings and names no account label.
    const kimiSource = sources.find((s) => s.label === "kimi-me-699") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string; label?: string }[]>;
    };
    expect(await kimiSource.discover({ kind: "global" })).toEqual([
      { key: "kimi-kimi_a", harness: "Kimi", input: { provider: "kimi", entryId: "kimi_a" } },
    ]);
    expect(await kimiSource.discover({ kind: "session", provider: "x" } as never)).toEqual([]);

    // The catch-all covers exactly the entries without their own source.
    const catchAll = sources.find((s) => s.label === "Kimi（新订阅）") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect((await catchAll.discover({ kind: "global" })).map((a) => a.key)).toEqual([]);

    const live = {
      ...bootConfig,
      kimi: [...bootConfig.kimi, { id: "kimi_new", label: "new", key: "sk-n", enabled: true }],
    };
    const liveServer = stubServer();
    registerCodingQuotaUsageSource(liveServer.server as never, async () => live);
    const liveCatchAll = liveServer.sources.find(
      (s) => s.label === "Kimi（新订阅）",
    ) as unknown as { discover: (scope: { kind: string }) => Promise<{ key: string }[]> };
    expect((await liveCatchAll.discover({ kind: "global" })).map((a) => a.key)).toEqual([
      "kimi-kimi_new",
    ]);
  });

  it("hides disabled entries from discover without deleting their data", async () => {
    process.env.PASEO_HOME = bootDir;
    mkdirSync(join(bootDir, "plugin-settings", "paseo-coding-quota"), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(bootConfig));

    const live = {
      ...bootConfig,
      kimi: [
        bootConfig.kimi[0],
        { ...bootConfig.kimi[1], enabled: false },
        { id: "kimi_off", label: "off", key: "sk-o", enabled: false },
      ],
      glm: [{ ...bootConfig.glm[0], enabled: false }],
    };
    const { server, sources } = stubServer();
    registerCodingQuotaUsageSource(server as never, async () => live);

    // Static registration is unchanged: every boot entry still owns a source.
    expect(sources.map((s) => s.label)).toContain("kimi-2-199");

    // The per-account source discovers nothing while the entry is disabled.
    const disabled = sources.find((s) => s.label === "kimi-2-199") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect(await disabled.discover({ kind: "global" })).toEqual([]);

    // The catch-all also skips disabled entries (covered or not).
    const catchAll = sources.find((s) => s.label === "Kimi（新订阅）") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect(await catchAll.discover({ kind: "global" })).toEqual([]);

    const glmCatchAll = sources.find((s) => s.label === "GLM（新订阅）") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect(await glmCatchAll.discover({ kind: "global" })).toEqual([]);

    // Enabled entries are unaffected.
    const enabled = sources.find((s) => s.label === "kimi-me-699") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect((await enabled.discover({ kind: "global" })).map((a) => a.key)).toEqual(["kimi-kimi_a"]);
  });

  it("provider-named fallback sources skip disabled entries", async () => {
    process.env.PASEO_HOME = join(bootDir, "does-not-exist");
    const live = {
      ...bootConfig,
      kimi: [{ ...bootConfig.kimi[0], enabled: false }, bootConfig.kimi[1]],
    };
    const { server, sources } = stubServer();
    registerCodingQuotaUsageSource(server as never, async () => live);
    const kimi = sources.find((s) => s.label === "Kimi") as unknown as {
      discover: (scope: { kind: string }) => Promise<{ key: string }[]>;
    };
    expect((await kimi.discover({ kind: "global" })).map((a) => a.key)).toEqual(["kimi-kimi_b"]);
  });

  it("falls back to provider-named sources when the settings file is unreadable", () => {
    process.env.PASEO_HOME = join(bootDir, "does-not-exist");
    const { server, sources } = stubServer();
    registerCodingQuotaUsageSource(server as never, async () => bootConfig);
    expect(sources.map((s) => s.label)).toEqual(["Kimi", "GLM", "CmdCode", "Codex（ChatGPT）"]);
  });
});

describe("getQuotaReport", () => {
  it("omits disabled entries from the report without fetching them", async () => {
    const report = await getQuotaReport(async () => ({
      kimi: [{ id: "k", label: "L", key: "sk-disabled", enabled: false }],
      glm: [{ id: "g", label: "G", key: "sk-disabled", enabled: false }],
      commandcode: [{ id: "c", label: "C", key: "user_disabled", enabled: false }],
      codexEnabled: false,
    }));
    expect(report.kimi).toEqual([]);
    expect(report.glm).toEqual([]);
    expect(report.commandcode).toEqual([]);
    expect(report.codex).toBeNull();
  });
});
