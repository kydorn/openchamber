import { readConfig } from '../opencode/shared.js';
import { getCatalogProvider } from './catalog.js';

// Mirrors OpenCode's getSmallModel fallback chain:
// 1. `small_model` from the merged config layers ("provider/model").
// 2. GitHub Copilot's hidden utility models when Copilot is logged in.
// 3. Family-priority scan of the authenticated providers' catalog models.
const FAMILY_PRIORITY = ['gemini-flash', 'gpt-nano', 'claude-haiku'];
const COPILOT_UTILITY_MODELS = ['gpt-5.4-nano', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'];
// The ChatGPT-plan codex backend only accepts a small allowlist of models
// (nano/API-key models are rejected with 400) — this is its cheapest one.
const OPENAI_OAUTH_SMALL_MODEL = 'gpt-5.4-mini';

const AUTH_PROVIDER_ALIASES = {
  'github-copilot': ['github-copilot', 'copilot'],
};

export function getAuthEntryForProvider(auth, providerID) {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID];
  for (const alias of aliases) {
    const entry = auth?.[alias];
    if (entry && typeof entry === 'object') {
      return entry;
    }
  }
  return null;
}

export function isUsableAuthEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.type === 'api') return typeof entry.key === 'string' && entry.key.length > 0;
  if (entry.type === 'oauth') {
    return (typeof entry.access === 'string' && entry.access.length > 0)
      || (typeof entry.refresh === 'string' && entry.refresh.length > 0);
  }
  if (entry.type === 'wellknown') return typeof entry.token === 'string' && entry.token.length > 0;
  return false;
}

export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

const pickByFamily = (models, family) => {
  const matches = Object.values(models)
    .filter((model) => model && typeof model === 'object' && model.family === family);
  if (matches.length === 0) return null;
  matches.sort((a, b) => String(b.release_date || '').localeCompare(String(a.release_date || '')));
  return matches[0];
};

// Small-model candidates within ONE provider, by family priority. Copilot and
// ChatGPT-plan OpenAI have fixed small models that never appear in the
// catalog; everyone else is scanned through the catalog families.
const pickWithinProvider = (providerID, auth, catalog, family) => {
  if (providerID === 'openai' && auth.openai?.type === 'oauth') {
    return family === 'gpt-nano'
      ? { providerID, modelID: OPENAI_OAUTH_SMALL_MODEL, source: 'codex-small' }
      : null;
  }
  if (providerID === 'github-copilot') {
    return family === 'gpt-nano'
      ? { providerID, modelID: COPILOT_UTILITY_MODELS[0], source: 'copilot-utility' }
      : null;
  }
  const provider = getCatalogProvider(catalog, providerID);
  if (!provider || !provider.models || typeof provider.models !== 'object') return null;
  const model = pickByFamily(provider.models, family);
  return model?.id ? { providerID, modelID: model.id, source: 'family-scan' } : null;
};

// Credential/URL presence for a provider from the merged OpenCode config
// layers. A `{env:NAME}` key counts only when the variable is set — an unset
// reference would otherwise shadow a previously-working fallback with a
// call-time error. `{file:}` refs and the actual call stay in call.js, which
// throws properly when broken.
export const readProviderConfig = (config, providerID) => {
  const cfg = config?.provider?.[providerID];
  if (!cfg || typeof cfg !== 'object') return null;
  let apiKey = typeof cfg.options?.apiKey === 'string' && cfg.options.apiKey.trim()
    ? cfg.options.apiKey.trim()
    : null;
  if (apiKey) {
    const envMatch = apiKey.match(/^\{env:([^}]+)\}$/i);
    if (envMatch && !process.env[envMatch[1].trim()]?.trim()) {
      apiKey = null;
    }
  }
  return {
    baseURL: typeof cfg.options?.baseURL === 'string' && cfg.options.baseURL.trim()
      ? cfg.options.baseURL.trim()
      : null,
    apiKey,
  };
};

export function resolveSmallModel({ auth, catalog, settingsSmallModel, configSmallModel, preferredProviderID, preferredModelID, workingDirectory }) {
  // OpenChamber's own setting (Settings → Sessions → Small Model override)
  // outranks everything, including the OpenCode config.
  const fromSettings = parseModelRef(settingsSmallModel);
  if (fromSettings) {
    return { ...fromSettings, source: 'settings' };
  }

  const explicit = parseModelRef(configSmallModel);
  if (explicit) {
    return { ...explicit, source: 'config' };
  }

  // Like OpenCode: when the caller has a session context, the utility call
  // stays on the session's provider. Scan its families for a small model,
  // otherwise run on the session's own model — never silently switch to a
  // different provider's subscription. A config-supplied apiKey counts as a
  // login (call.js uses the same precedence: config key wins, auth.json next).
  // A malformed config file must not break previously-working auth-based
  // resolution, so the read is guarded like every other config read here.
  let config = null;
  if (workingDirectory) {
    try {
      config = readConfig(workingDirectory);
    } catch {
      config = null;
    }
  }
  const preferred = typeof preferredProviderID === 'string' && preferredProviderID
    ? preferredProviderID
    : null;
  const preferredUsable = preferred && (
    isUsableAuthEntry(getAuthEntryForProvider(auth, preferred))
    || Boolean(readProviderConfig(config, preferred)?.apiKey)
  );
  if (preferredUsable) {
    for (const family of FAMILY_PRIORITY) {
      const match = pickWithinProvider(preferred, auth, catalog, family);
      if (match) return match;
    }
    if (typeof preferredModelID === 'string' && preferredModelID) {
      return { providerID: preferred, modelID: preferredModelID, source: 'session-model' };
    }
  }

  // No session context (or its provider has no usable login): scan all
  // authenticated providers by family priority.
  const authedProviders = Object.keys(auth || {}).filter((providerID) =>
    providerID !== preferred && isUsableAuthEntry(auth[providerID]));

  for (const family of FAMILY_PRIORITY) {
    for (const providerID of authedProviders) {
      const match = pickWithinProvider(providerID, auth, catalog, family);
      if (match) return match;
    }
  }

  // Providers defined in the OpenCode config (custom OpenAI-compatible
  // endpoints such as Ollama or LM Studio) outrank Copilot's passive utility
  // fallback: the user configured them explicitly. The call path already
  // resolves their baseURL and credentials; selection is the only missing
  // piece. Credentials may live in the config apiKey or in auth.json under
  // the same provider name. Deliberately a distinct source — an unrequested
  // pick, not the user's explicit small_model choice.
  for (const [providerID, cfg] of Object.entries(config?.provider || {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (!readProviderConfig(config, providerID)?.baseURL) continue;
    if (!readProviderConfig(config, providerID)?.apiKey
      && !isUsableAuthEntry(getAuthEntryForProvider(auth, providerID))) continue;
    const configModels = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
    const models = { ...(catalog?.[providerID]?.models || {}), ...configModels };
    const entries = Object.values(models).filter((model) => model && typeof model === 'object');
    if (entries.length === 0) continue;
    let picked = null;
    for (const family of FAMILY_PRIORITY) {
      picked = pickByFamily(models, family);
      if (picked) break;
    }
    if (!picked) picked = entries[0];
    return { providerID, modelID: picked.id, source: 'config-provider' };
  }

  // Copilot's utility fallback for legacy auth aliases the loop above missed.
  const copilotEntry = getAuthEntryForProvider(auth, 'github-copilot');
  if (isUsableAuthEntry(copilotEntry)) {
    return {
      providerID: 'github-copilot',
      modelID: COPILOT_UTILITY_MODELS[0],
      source: 'copilot-utility',
    };
  }

  return null;
}
