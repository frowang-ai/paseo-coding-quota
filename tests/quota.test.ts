import { describe, expect, it } from "vitest";
import { codexWindowLabel, glmWindowLabel, mapCodexBody, mapGlmBody, mapKimiBody } from "../server/quota";

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
