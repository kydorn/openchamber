import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp,
  formatMoney,
  asNonEmptyString
} from '../utils/index.js';

export const providerId = 'neuralwatt';
export const providerName = 'NeuralWatt';
const aliases = ['neuralwatt'];
const NEURALWATT_QUOTA_URL = 'https://api.neuralwatt.com/v1/quota';

// 30d month / 365d year are fixed approximations; real calendars vary but the
// window is for the UI's progress bar label, not billing decisions.
const periodToWindowSeconds = (period) => {
  if (period === 'daily') return 86400;
  if (period === 'weekly') return 604800;
  if (period === 'monthly' || period === 'month') return 30 * 86400;
  if (period === 'yearly' || period === 'year') return 365 * 86400;
  return null;
};

const capitalizeFirst = (value) => {
  if (typeof value !== 'string' || !value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const computeAllowanceResetAt = (period) => {
  const now = new Date();
  if (period === 'daily') {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  }
  if (period === 'weekly') {
    const day = now.getUTCDay();
    const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday, 0, 0, 0);
  }
  if (period === 'monthly') {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0);
  }
  return null;
};

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
};

export const fetchQuota = async () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const apiKey = entry?.key ?? entry?.token;

  if (!apiKey) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const timeoutSignal = AbortSignal.timeout(15_000);

  try {
    const response = await fetch(NEURALWATT_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Accept-Encoding': 'identity'
      },
      signal: timeoutSignal
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired — please re-authenticate with NeuralWatt'
          : `API error: ${response.status}`
      });
    }

    const payload = await response.json();
    const subscription = payload?.subscription ?? null;
    const inOverage = Boolean(subscription?.in_overage);
    const allowance = payload?.key?.allowance ?? null;
    const keyName = payload?.key?.name ?? null;
    const creditsRemaining = toNumber(payload?.balance?.credits_remaining_usd);

    const windows = {};

    if (subscription) {
      const kwhIncluded = toNumber(subscription.kwh_included);
      const kwhUsed = toNumber(subscription.kwh_used);
      const plan = asNonEmptyString(subscription.plan);
      const billingInterval = asNonEmptyString(subscription.billing_interval);
      const subLabel = [capitalizeFirst(plan), billingInterval].filter(Boolean).join(' - ');
      const usedPercent = inOverage
        ? 100
        : (kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
            ? Math.max(0, Math.min(100, (kwhUsed / kwhIncluded) * 100))
            : null);
      const subResetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end);
      const windowSeconds = periodToWindowSeconds(billingInterval);
      if (subLabel) {
        windows[subLabel] = toUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt: subResetAt,
          ...(inOverage ? { valueLabel: '(exhausted)' } : {})
        });
      }
    }

    if (allowance) {
      const spent = toNumber(allowance.spent_usd);
      const limit = toNumber(allowance.limit_usd);
      const effectiveLimit = limit !== null && creditsRemaining !== null
        ? Math.min(limit, creditsRemaining)
        : (limit ?? creditsRemaining);
      const period = asNonEmptyString(allowance.period);
      const labelName = asNonEmptyString(keyName);
      const labelParts = labelName ? [`${capitalizeFirst(labelName)} key`] : [];
      if (period) labelParts.push(period);
      const allowLabel = labelParts.join(' - ');
      const blocked = Boolean(allowance.blocked);
      const usedPercent = blocked
        ? 100
        : (spent !== null && effectiveLimit !== null && effectiveLimit > 0
            ? Math.max(0, Math.min(100, (spent / effectiveLimit) * 100))
            : null);
      const resetAt = toTimestamp(allowance.reset_at) ?? (period ? computeAllowanceResetAt(period) : null);
      const windowSeconds = period ? periodToWindowSeconds(period) : null;
      if (allowLabel) {
        windows[allowLabel] = toUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt,
          ...(blocked ? { valueLabel: '(blocked)' } : {})
        });
      }
    } else if (creditsRemaining !== null) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(creditsRemaining)}`
      });
    }

    if (Object.keys(windows).length === 0) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: 'No quota data in response'
      });
    }

    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows }
    });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError' && timeoutSignal.aborted;
    const isParseError = error instanceof SyntaxError;
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: isTimeout
        ? 'Request timed out'
        : isParseError
          ? 'Invalid response from provider'
          : (error instanceof Error ? error.message : 'Request failed')
    });
  }
};
