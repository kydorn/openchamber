import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ neuralwatt: { key: 'test-token' } }),
}));

import { fetchQuota } from './neuralwatt.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const mockResponse = (body, init = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
  ...init,
});

// Documented payload shape from https://portal.neuralwatt.com/docs/api/quota
// Subscription has kwh_included=20.0, kwh_used=13.9023, billing_interval="month"
// (NOT "monthly" — that value only appears on key.allowance.period).
const DOCUMENTED_SUBSCRIPTION_PAYLOAD = {
  snapshot_at: '2026-04-16T18:30:00Z',
  balance: { credits_remaining_usd: 32.6774, total_credits_usd: 52.34, credits_used_usd: 19.6626, accounting_method: 'energy' },
  usage: { lifetime: { cost_usd: 243.9145, requests: 37801, tokens: 1235477176, energy_kwh: 15.6009 }, current_month: { cost_usd: 160.1463, requests: 23902, tokens: 1116658995, energy_kwh: 9.7278 } },
  limits: { overage_limit_usd: null, rate_limit_tier: 'standard' },
  subscription: {
    plan: 'standard',
    status: 'active',
    billing_interval: 'month',
    current_period_start: '2026-04-11T05:05:25Z',
    current_period_end: '2026-05-11T05:05:25Z',
    auto_renew: true,
    kwh_included: 20.0,
    kwh_used: 13.9023,
    kwh_remaining: 6.0977,
    in_overage: false,
  },
  key: { name: 'my-production-key', allowance: null },
};

describe('NeuralWatt quota provider', () => {
  it('builds subscription window from documented payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(DOCUMENTED_SUBSCRIPTION_PAYLOAD)));

    const result = await fetchQuota();

    expect(result.ok).toBe(true);
    expect(result.providerId).toBe('neuralwatt');

    const window = result.usage.windows['Standard - month'];
    expect(window).toBeDefined();
    expect(window.usedPercent).toBeCloseTo((13.9023 / 20.0) * 100, 4);
    expect(window.windowSeconds).toBe(30 * 86400);
    expect(window.resetAt).toBe(Date.parse('2026-05-11T05:05:25Z'));

    // allowance is null, so the credits_balance window is *also* surfaced
    // (the suppression condition is `!allowance`, not "subscription present").
    expect(result.usage.windows.credits_balance).toBeDefined();
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
  });

  it('uses yearly windowSeconds for annual billing interval', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: {
        ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription,
        billing_interval: 'year',
        current_period_end: '2027-04-11T05:05:25Z',
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows['Standard - year'];
    expect(window).toBeDefined();
    expect(window.windowSeconds).toBe(365 * 86400);
    expect(window.resetAt).toBe(Date.parse('2027-04-11T05:05:25Z'));
  });

  it('marks in-overage subscription as exhausted (100% with label), still shows credits', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, in_overage: true, kwh_used: 25.0 },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    // Subscription is still shown, but as exhausted
    const window = result.usage.windows['Standard - month'];
    expect(window).toBeDefined();
    expect(window.usedPercent).toBe(100);
    expect(window.valueLabel).toBe('(exhausted)');
    // Allowance is null, so credits_balance is independently surfaced
    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
  });

  it('surfaces both subscription and allowance windows when both are present', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      balance: { credits_remaining_usd: 200 }, // > limit so effectiveLimit = limit = 100
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    // Subscription window with kWh data
    const subWindow = result.usage.windows['Standard - month'];
    expect(subWindow).toBeDefined();
    expect(subWindow.usedPercent).toBeCloseTo((13.9023 / 20.0) * 100, 4);

    // Allowance window (independent of subscription)
    const allowWindow = result.usage.windows['Prod key - monthly'];
    expect(allowWindow).toBeDefined();
    expect(allowWindow.usedPercent).toBe(25);

    // credits_balance suppressed because allowance is present
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('shows exhausted subscription and allowance together, suppresses credits', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      balance: { credits_remaining_usd: 200 },
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, in_overage: true },
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    // Exhausted subscription still shown
    expect(result.usage.windows['Standard - month'].usedPercent).toBe(100);
    expect(result.usage.windows['Standard - month'].valueLabel).toBe('(exhausted)');
    // Allowance still shown
    expect(result.usage.windows['Prod key - monthly']).toBeDefined();
    // credits_balance suppressed
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('uses allowance effective limit = min(limit, credits_remaining) when both present', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows['Prod-key key - monthly'];
    expect(window).toBeDefined();
    // effectiveLimit = min(100, 30) = 30; usedPercent = 25/30 * 100 = 83.33...
    expect(window.usedPercent).toBeCloseTo((25 / 30) * 100, 4);
    expect(window.windowSeconds).toBe(30 * 86400);
    expect(result.usage.windows.credits_balance).toBeUndefined();
  });

  it('marks blocked allowance as 100% with (blocked) label', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'sample',
        allowance: { limit_usd: 50, period: 'monthly', spent_usd: 10, blocked: true },
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    const window = result.usage.windows['Sample key - monthly'];
    expect(window.usedPercent).toBe(100);
    expect(window.valueLabel).toBe('(blocked)');
  });

  it('falls back to credits_balance when neither subscription nor allowance exists', async () => {
    const payload = {
      balance: { credits_remaining_usd: 32.6774 },
      subscription: null,
      key: { name: 'sample', allowance: null },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(payload)));

    const result = await fetchQuota();

    expect(result.usage.windows.credits_balance.valueLabel).toBe('$32.68');
    expect(result.usage.windows.credits_balance.usedPercent).toBeNull();
  });

  it('maps 401 to session-expired error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Session expired — please re-authenticate with NeuralWatt');
  });

  it('reports invalid-response on JSON parse failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await fetchQuota();

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid response from provider');
  });
});
