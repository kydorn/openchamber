import fs from 'fs';
import os from 'os';
import path from 'path';
import { readAuthFile } from '../opencode/auth.js';
import { readConfig, readConfigLayers } from '../opencode/shared.js';
import { getModelCatalog } from './catalog.js';
import { resolveSmallModel, parseModelRef, isUsableAuthEntry, getAuthEntryForProvider, readProviderConfig } from './resolve.js';
import { callSmallModel, resolveProviderLogin } from './call.js';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

// OpenChamber's own settings: when the user unchecks "use default small model"
// their explicit override outranks every other resolution step.
const readSmallModelSettingsOverride = () => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object') return null;
    if (settings.smallModelUseDefault !== false) return null;
    const override = typeof settings.smallModelOverride === 'string' ? settings.smallModelOverride.trim() : '';
    return override || null;
  } catch {
    return null;
  }
};

// Rough safety clamp so a huge input never blows the model's context window.
// Token estimate is ~4 chars/token; when the catalog has no limit for the
// model (Copilot/codex utility models are not listed) a conservative default
// applies.
const DEFAULT_CONTEXT_TOKENS = 64_000;
const OUTPUT_RESERVE_TOKENS = 4_000;

/**
 * Input budget in characters, given how much of the context the caller intends
 * to leave for the answer. The reserve must match the output budget the caller
 * will actually request, or the two disagree and the model overruns its context.
 */
export const getModelInputCharBudget = ({ catalog, providerID, modelID, outputReserveTokens }) => {
  const limit = catalog?.[providerID]?.models?.[modelID]?.limit;
  const known = Number(limit?.context) > 0;
  const contextTokens = known ? Number(limit.context) : DEFAULT_CONTEXT_TOKENS;
  const reserve = Number(outputReserveTokens) > 0 ? Number(outputReserveTokens) : OUTPUT_RESERVE_TOKENS;
  const inputBudgetTokens = Math.max(1_000, contextTokens - reserve);
  return { maxChars: inputBudgetTokens * 4, contextTokens, contextKnown: known };
};

/**
 * The output budget to actually request: what the caller asked for, capped by
 * what the model admits it can emit. Asking for more than `limit.output` is
 * rejected outright by some providers and silently ignored by others.
 */
const resolveOutputTokens = ({ catalog, providerID, modelID, maxOutputTokens }) => {
  const requested = Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : 0;
  if (!requested) return undefined;
  const limit = Number(catalog?.[providerID]?.models?.[modelID]?.limit?.output);
  return limit > 0 ? Math.min(requested, limit) : requested;
};

// `truncate` keeps the historical behavior for callers whose prompt losing its
// tail is survivable (summaries, commit messages). `error` is for callers whose
// output would be quietly wrong on a clipped input — they need the failure.
const clampPromptToModelLimit = ({ prompt, catalog, providerID, modelID, onOverflow, outputReserveTokens }) => {
  const { maxChars } = getModelInputCharBudget({ catalog, providerID, modelID, outputReserveTokens });
  if (prompt.length <= maxChars) {
    return { prompt, truncated: false };
  }
  if (onOverflow === 'error') {
    throw Object.assign(
      new Error(`Input is too large for ${providerID}/${modelID}: ${prompt.length} characters exceeds the ${maxChars} the model's context allows`),
      { statusCode: 413, code: 'context-too-small', providerID, modelID, requiredChars: prompt.length, availableChars: maxChars },
    );
  }
  return { prompt: `${prompt.slice(0, maxChars)}…`, truncated: true };
};

const readConfiguredSmallModel = (workingDirectory) => {
  try {
    const { mergedConfig } = readConfigLayers(workingDirectory);
    const value = mergedConfig?.small_model;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
};

const readMergedConfig = (workingDirectory) => {
  if (!workingDirectory) return null;
  try {
    return readConfig(workingDirectory);
  } catch {
    // A malformed config file must not break resolution that does not need it.
    return null;
  }
};

// Config model records (opencode `provider.<id>.models`) can declare limits
// for models models.dev does not know — custom OpenAI-compatible endpoints
// especially. Overlay the config's record over the catalog so budget and
// capability checks see the same numbers OpenCode itself uses.
const mergeConfigModel = (catalog, config, providerID, modelID) => {
  const model = config?.provider?.[providerID]?.models?.[modelID];
  if (!model || typeof model !== 'object') return catalog;
  return {
    ...catalog,
    [providerID]: {
      ...(catalog?.[providerID] || {}),
      models: { ...(catalog?.[providerID]?.models || {}), [modelID]: model },
    },
  };
};

/**
 * Generates text with the user's small model, resolved and authenticated
 * entirely server-side from the OpenCode config and auth store.
 */
export async function generateSmallModelText({ prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID, restrictToPreferredProvider = false, responseSchema, timeoutMs, signal, onOverflow = 'truncate' }) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw Object.assign(new Error('prompt is required'), { statusCode: 400 });
  }

  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));

  const explicit = parseModelRef(model);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: readConfiguredSmallModel(directory),
      preferredProviderID,
      preferredModelID,
      workingDirectory: directory,
    });

  if (!resolved) {
    throw Object.assign(
      new Error('No small model available — no authenticated provider has a suitable model'),
      { statusCode: 404 },
    );
  }

  // Callers with a session context can forbid silently switching providers:
  // an explicit user choice (settings override, opencode config, request
  // model) is always allowed, anything else must stay on the session's
  // provider.
  if (restrictToPreferredProvider
    && !['settings', 'config', 'request'].includes(resolved.source)
    && resolved.providerID !== preferredProviderID) {
    throw Object.assign(
      new Error('No small model available within the session provider'),
      { statusCode: 404 },
    );
  }

  const mergedCatalog = mergeConfigModel(
    catalog,
    readMergedConfig(directory),
    resolved.providerID,
    resolved.modelID,
  );

  const outputTokens = resolveOutputTokens({
    catalog: mergedCatalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    maxOutputTokens,
  });

  const clamped = clampPromptToModelLimit({
    prompt: prompt.trim(),
    catalog: mergedCatalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    onOverflow,
    outputReserveTokens: outputTokens,
  });

  const text = await callSmallModel({
    auth,
    catalog: mergedCatalog,
    workingDirectory: directory,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    prompt: clamped.prompt,
    system: typeof system === 'string' && system.trim() ? system.trim() : undefined,
    maxOutputTokens: outputTokens,
    responseSchema,
    timeoutMs,
    signal,
  });

  return {
    text: text.trim(),
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    source: resolved.source,
    ...(clamped.truncated ? { inputTruncated: true } : {}),
  };
}

/**
 * Provider ids with a usable OpenCode login — the set the small model can
 * actually call. Used by the settings override picker to hide providers that
 * would only ever fail (e.g. opencode free models without a token).
 *
 * A config-defined provider counts when it has a baseURL and a credential
 * somewhere (its own apiKey or an auth.json entry under the same provider
 * name) — the picker must be able to select the same custom endpoints the
 * regular agent uses.
 */
export function listAuthenticatedProviders({ workingDirectory } = {}) {
  const ids = new Set();
  try {
    const auth = readAuthFile();
    for (const providerID of Object.keys(auth || {})) {
      if (isUsableAuthEntry(auth[providerID])) {
        ids.add(providerID);
      }
    }
    // The catalog id is github-copilot while legacy auth entries may sit
    // under the copilot alias.
    if (isUsableAuthEntry(getAuthEntryForProvider(auth, 'github-copilot'))) {
      ids.add('github-copilot');
    }
  } catch {
    // Fall through: config providers below may still be listable.
  }
  try {
    const config = workingDirectory ? readConfig(workingDirectory) : null;
    for (const [providerID, cfg] of Object.entries(config?.provider || {})) {
      if (!cfg || typeof cfg !== 'object') continue;
      const { baseURL, apiKey } = readProviderConfig(config, providerID);
      const models = cfg.models && typeof cfg.models === 'object' ? Object.keys(cfg.models) : [];
      if (!baseURL || models.length === 0) continue;
      if (!apiKey && !ids.has(providerID)) continue;
      ids.add(providerID);
    }
  } catch {
    // Unreadable config: report what auth.json already gave us.
  }
  return Array.from(ids);
}

/**
 * Reports which model would be used, without calling it.
 *
 * `inputCharBudget` and `structuredOutput` let callers refuse work before
 * spending a request: the walkthrough needs both a big enough context and
 * schema-shaped output, and would rather tell the user to pick another model
 * than send a doomed prompt. `structuredOutput` is deliberately tri-state —
 * the catalog omits the field for roughly half of all models (aggregators and
 * proxies especially), and treating "unknown" as "unsupported" would hide
 * models that work fine.
 */
/**
 * The reserve, resolved against the model that was actually picked.
 *
 * A caller that wants "as much answer room as this model allows" cannot state a
 * number up front — it does not know which model it will get. Passing a
 * function lets it decide once the limits are known, and keeps the reserve and
 * the eventual request the same number by construction.
 */
const resolveReserveTokens = (outputReserveTokens, limits) => (
  typeof outputReserveTokens === 'function' ? outputReserveTokens(limits) : outputReserveTokens
);

export async function describeSmallModel({ directory, preferredProviderID, preferredModelID, outputReserveTokens, overrideModel } = {}) {
  const auth = readAuthFile();
  const catalog = await getModelCatalog().catch(() => ({}));
  // A caller with its own model setting (the diff walkthrough) outranks the
  // small-model chain entirely — it asked for this model on purpose.
  const explicit = parseModelRef(overrideModel);
  const resolved = explicit
    ? { ...explicit, source: 'request' }
    : resolveSmallModel({
      auth,
      catalog,
      settingsSmallModel: readSmallModelSettingsOverride(),
      configSmallModel: readConfiguredSmallModel(directory),
      preferredProviderID,
      preferredModelID,
      workingDirectory: directory,
    });
  if (!resolved) return resolved;

  const mergedCatalog = mergeConfigModel(
    catalog,
    readMergedConfig(directory),
    resolved.providerID,
    resolved.modelID,
  );
  const entry = mergedCatalog?.[resolved.providerID]?.models?.[resolved.modelID];
  const outputTokenLimit = Number(entry?.limit?.output) > 0 ? Number(entry.limit.output) : null;
  // Two passes: the first only to learn the context, which a caller-supplied
  // reserve function needs before it can answer.
  const { contextTokens, contextKnown } = getModelInputCharBudget({
    catalog: mergedCatalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
  });
  const reserveTokens = resolveReserveTokens(outputReserveTokens, { contextTokens, outputTokenLimit });
  const { maxChars } = getModelInputCharBudget({
    catalog: mergedCatalog,
    providerID: resolved.providerID,
    modelID: resolved.modelID,
    outputReserveTokens: reserveTokens,
  });

  // Settings/config/request overrides can name a provider with no usable login.
  // Report that here so readiness can refuse before the user pays for a 401.
  const hasLogin = Boolean(resolveProviderLogin({
    auth,
    workingDirectory: directory,
    providerID: resolved.providerID,
  }));

  return {
    ...resolved,
    hasLogin,
    inputCharBudget: maxChars,
    contextTokens,
    contextKnown,
    // What the caller should ask for, so the request and the reserve above
    // cannot drift apart.
    outputTokens: Number(reserveTokens) > 0 ? Number(reserveTokens) : null,
    structuredOutput: typeof entry?.structured_output === 'boolean' ? entry.structured_output : null,
    outputTokenLimit,
  };
}
