import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// readAuthFile reads ~/.local/share/opencode/auth.json via fs.readFileSync.
// Stub fs to serve a known auth entry so the providers treat themselves as
// configured and proceed straight to fetch.
const ORIGINAL_FS = { ...fs };
const AUTH = JSON.stringify({
  crof: { key: 'test-token' },
  neuralwatt: { key: 'test-token' },
});
((fs as unknown) as { existsSync: () => boolean }).existsSync = () => true;
((fs as unknown) as { readFileSync: () => string }).readFileSync = () => AUTH;

import { fetchQuotaForProvider } from './quotaProviders';

type MockResponseInit = { ok?: boolean; status?: number };

const mockResponse = (body: unknown, init: MockResponseInit = {}): Response => ({
  ok: 'ok' in init ? init.ok! : true,
  status: init.status ?? 200,
  json: async () => body,
} as unknown as Response);

// Documented NeuralWatt payload from https://portal.neuralwatt.com/docs/api/quota.
// kwh_included=20.0, kwh_used=13.9023, billing_interval="month" (NOT "monthly").
const DOCUMENTED_SUBSCRIPTION_PAYLOAD = {
  snapshot_at: '2026-04-16T18:30:00Z',
  balance: { credits_remaining_usd: 32.6774, total_credits_usd: 52.34, credits_used_usd: 19.6626, accounting_method: 'energy' },
  usage: {
    lifetime: { cost_usd: 243.9145, requests: 37801, tokens: 1235477176, energy_kwh: 15.6009 },
    current_month: { cost_usd: 160.1463, requests: 23902, tokens: 1116658995, energy_kwh: 9.7278 },
  },
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
} as const;

let ORIGINAL_FETCH: typeof globalThis.fetch;

beforeEach(() => {
  ORIGINAL_FETCH = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

const stubFetchReturning = (resolver: () => Promise<unknown>): void => {
  globalThis.fetch = (async () => resolver()) as typeof fetch;
};

const stubFetchFailing = (json: () => Promise<unknown>, init: MockResponseInit): void => {
  globalThis.fetch = (async () => ({ json, ...init }) as unknown as Response) as typeof fetch;
};

describe('Crof quota provider (VS Code parity)', () => {
  test('reports credits balance as valueLabel with null percent', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ usable_requests: 450, credits: 12.3456 })));

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'crof');
    assert.equal(result.usage!.windows.credits!.usedPercent, null);
    assert.equal(result.usage!.windows.credits!.valueLabel, '$12.35');
  });

  test('tolerates missing credits field', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({ usable_requests: 0 })));

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, true);
    assert.equal(result.usage!.windows.credits!.valueLabel, undefined);
    assert.equal(result.usage!.windows.credits!.usedPercent, null);
  });

  test('maps 401 to session-expired with CrofAI branding', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'Session expired — please re-authenticate with CrofAI');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('crof');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });
});

describe('NeuralWatt quota provider (VS Code parity)', () => {
  test('builds subscription window from documented payload', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse(DOCUMENTED_SUBSCRIPTION_PAYLOAD)));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, true);
    assert.equal(result.providerId, 'neuralwatt');

    const window = result.usage!.windows.subscription;
    assert.ok(window, 'subscription window should be defined');
    assert.ok(Math.abs((window.usedPercent as number) - (13.9023 / 20.0) * 100) < 1e-2);
    assert.equal(window.windowSeconds, 30 * 86400);
    assert.equal(window.resetAt, Date.parse('2026-05-11T05:05:25Z'));

    // allowance is null → credits_balance also surfaced
    assert.ok(result.usage!.windows.credits_balance, 'credits_balance should be defined');
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
  });

  test('uses yearly windowSeconds for annual billing interval', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: {
        ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription,
        billing_interval: 'year',
        current_period_end: '2027-04-11T05:05:25Z',
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.subscription;
    assert.ok(window);
    assert.equal(window!.windowSeconds, 365 * 86400);
    assert.equal(window!.resetAt, Date.parse('2027-04-11T05:05:25Z'));
  });

  test('marks in-overage subscription as 100%, still shows credits', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      subscription: { ...DOCUMENTED_SUBSCRIPTION_PAYLOAD.subscription, in_overage: true, kwh_used: 25.0 },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.subscription;
    assert.ok(window);
    assert.equal(window!.usedPercent, 100);
    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
  });

  test('surfaces both subscription and allowance windows when both are present', async () => {
    const payload = {
      ...DOCUMENTED_SUBSCRIPTION_PAYLOAD,
      balance: { credits_remaining_usd: 200 }, // credits >= limit so effectiveLimit = limit = 100
      key: {
        name: 'Prod',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const subWindow = result.usage!.windows.subscription;
    assert.ok(subWindow);
    assert.ok(Math.abs((subWindow!.usedPercent as number) - (13.9023 / 20.0) * 100) < 1e-2);

    // min(100, 200+25) = 100 → 25/100 = 25%
    const allowWindow = result.usage!.windows.key_allowance;
    assert.ok(allowWindow);
    assert.equal(allowWindow!.usedPercent, 25);
    assert.equal(allowWindow!.resetAt, Date.parse('2026-08-01T00:00:00Z'));

    assert.equal(result.usage!.windows.credits_balance, undefined);
  });

  test('uses allowance effective limit = min(limit, credits_remaining + spent)', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.key_allowance;
    assert.ok(window);
    // effectiveLimit = min(100, 30+25) = 55; usedPercent = 25/55 * 100 ≈ 45.4545
    assert.ok(Math.abs((window!.usedPercent as number) - (25 / 55) * 100) < 1e-2);
    assert.equal(window!.windowSeconds, 30 * 86400);
    assert.equal(window!.resetAt, Date.parse('2026-08-01T00:00:00Z'));
    assert.equal(result.usage!.windows.credits_balance, undefined);
  });

  test('binds allowance ceiling to limit when limit < credits_remaining + spent', async () => {
    const payload = {
      balance: { credits_remaining_usd: 200 },
      subscription: null,
      key: {
        name: 'prod-key',
        allowance: { limit_usd: 100, period: 'monthly', spent_usd: 25, blocked: false, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.key_allowance;
    assert.ok(window);
    assert.equal(window!.usedPercent, 25);
  });

  test('marks blocked allowance as 100%', async () => {
    const payload = {
      balance: { credits_remaining_usd: 30 },
      subscription: null,
      key: {
        name: 'sample',
        allowance: { limit_usd: 50, period: 'monthly', spent_usd: 10, blocked: true, reset_at: '2026-08-01T00:00:00Z' },
      },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    const window = result.usage!.windows.key_allowance;
    assert.ok(window);
    assert.equal(window!.usedPercent, 100);
  });

  test('falls back to credits_balance when neither subscription nor allowance exists', async () => {
    const payload = {
      balance: { credits_remaining_usd: 32.6774 },
      subscription: null,
      key: { name: 'sample', allowance: null },
    };
    stubFetchReturning(() => Promise.resolve(mockResponse(payload)));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.usage!.windows.credits_balance!.valueLabel, '$32.68');
    assert.equal(result.usage!.windows.credits_balance!.usedPercent, null);
  });

  test('maps 401 to session-expired', async () => {
    stubFetchFailing(async () => ({}), { ok: false, status: 401 });

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Session expired — please re-authenticate with NeuralWatt');
  });

  test('reports invalid-response on JSON parse failure', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }) as unknown as Response) as typeof fetch;

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid response from provider');
  });

  test('returns no-quota-data on a 200 payload with no usable windows', async () => {
    stubFetchReturning(() => Promise.resolve(mockResponse({
      balance: { credits_remaining_usd: null },
      subscription: null,
      key: { name: 'sample', allowance: null },
    })));

    const result = await fetchQuotaForProvider('neuralwatt');

    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.equal(result.error, 'No quota data in response');
    assert.equal(result.usage, null);
  });

  // Restore fs so other test files (which use the real auth file) are unaffected.
  test('teardown: restore fs', () => {
    const fsMock = fs as unknown as { existsSync: unknown; readFileSync: unknown };
    fsMock.existsSync = ORIGINAL_FS.existsSync;
    fsMock.readFileSync = ORIGINAL_FS.readFileSync;
  });
});
