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

const capitalizeFirst = (value) => {
  if (typeof value !== 'string' || !value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
};

export const isConfigured = () => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  return Boolean(entry?.key || entry?.token);
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

const allowanceWindowSeconds = (period) => {
  if (period === 'daily') return 86400;
  if (period === 'weekly') return 604800;
  if (period === 'monthly') return 30 * 86400;
  return null;
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

  try {
    const response = await fetch(NEURALWATT_QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.status === 401
          ? 'Session expired \u2014 please re-authenticate with NeuralWatt'
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

    if (subscription && !inOverage) {
      const kwhIncluded = toNumber(subscription.kwh_included);
      const kwhUsed = toNumber(subscription.kwh_used);
      const plan = asNonEmptyString(subscription.plan);
      const billingInterval = asNonEmptyString(subscription.billing_interval);
      const subLabel = [capitalizeFirst(plan), billingInterval].filter(Boolean).join(' - ');
      const usedPercent = kwhIncluded !== null && kwhIncluded > 0 && kwhUsed !== null
        ? Math.max(0, Math.min(100, (kwhUsed / kwhIncluded) * 100))
        : null;
      const subResetAt = toTimestamp(subscription.kwh_reset_date) ?? toTimestamp(subscription.current_period_end);
      const windowSeconds = allowanceWindowSeconds('monthly');
      if (subLabel) {
        windows[subLabel] = toUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt: subResetAt
        });
      }
    } else if (allowance) {
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
      const windowSeconds = period ? allowanceWindowSeconds(period) : null;
      if (allowLabel) {
        windows[allowLabel] = toUsageWindow({
          usedPercent,
          windowSeconds,
          resetAt,
          ...(blocked ? { valueLabel: '(blocked)' } : {})
        });
      }
    }

    if (creditsRemaining !== null) {
      windows.credits_balance = toUsageWindow({
        usedPercent: null,
        windowSeconds: null,
        resetAt: null,
        valueLabel: `$${formatMoney(creditsRemaining)}`
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
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
