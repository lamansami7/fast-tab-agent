/**
 * Provider record model: creation, normalisation, validation, masking.
 *
 * A provider record is plain data so it can round-trip through
 * chrome.storage.local and chrome.runtime messaging without surprises.
 *
 * {
 *   id, name, type: 'preset'|'custom', presetId,
 *   baseUrl, apiKey, model,
 *   endpointPath, authHeader, authScheme, extraHeaders, params,
 *   useJsonMode, temperature, maxTokens,
 *   createdAt, updatedAt
 * }
 *
 * Unknown fields are dropped on normalise, so a corrupted storage entry can
 * never smuggle unexpected data into a network request.
 */

import { LIMITS, PROVIDER_ID_RE } from './constants.js';
import { getPreset, CUSTOM_PROVIDER_DEFAULT_NAME } from './presets.js';
import { validateBaseUrl, validateEndpointPath, buildChatCompletionsUrl } from './urls.js';

const DEFAULT_AUTH_HEADER = 'Authorization';
const DEFAULT_AUTH_SCHEME = 'Bearer';

export function generateProviderId(seed = '') {
  let random = '';
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    random = cryptoObj.randomUUID().replace(/-/g, '');
  } else if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(8);
    cryptoObj.getRandomValues(bytes);
    random = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    random = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
  const safeSeed = String(seed).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
  const id = `p_${(safeSeed + random.replace(/[^a-z0-9]/g, '')).slice(0, 24)}`;
  return PROVIDER_ID_RE.test(id) ? id : `p_${random.slice(0, 16)}`;
}

export function isValidProviderId(id) {
  return typeof id === 'string' && PROVIDER_ID_RE.test(id);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keep only string/number/boolean leaves so params can't smuggle functions. */
function sanitizeParamObject(value, depth = 0) {
  if (depth > 4 || !isPlainObject(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || !key.trim() || key.length > 120) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (raw === null || typeof raw === 'string' || typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw;
    } else if (Array.isArray(raw)) {
      const arr = raw.filter(
        (item) =>
          item === null ||
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)),
      );
      if (arr.length) out[key] = arr;
    } else if (isPlainObject(raw)) {
      const nested = sanitizeParamObject(raw, depth + 1);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

function clampNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** Build a fresh provider from a preset (or a blank custom endpoint). */
export function createProvider(presetId = null, overrides = {}) {
  const preset = getPreset(presetId);
  const now = Date.now();
  const provider = {
    id: generateProviderId(preset ? preset.id : 'c'),
    name: preset ? preset.name : CUSTOM_PROVIDER_DEFAULT_NAME,
    type: preset ? 'preset' : 'custom',
    presetId: preset ? preset.id : null,
    baseUrl: preset ? preset.baseUrl : '',
    apiKey: '',
    model: preset ? preset.suggestedModel || '' : '',
    endpointPath: '',
    authHeader: DEFAULT_AUTH_HEADER,
    authScheme: DEFAULT_AUTH_SCHEME,
    extraHeaders: {},
    params: {},
    useJsonMode: false,
    temperature: null,
    maxTokens: null,
    createdAt: now,
    updatedAt: now,
  };
  return normalizeProvider({ ...provider, ...overrides }, { preserveTimestamps: false });
}

/**
 * Coerce arbitrary stored/imported data into a valid provider record.
 * Returns null when the record cannot be salvaged.
 */
export function normalizeProvider(raw, options = {}) {
  if (!isPlainObject(raw)) return null;

  const preset = getPreset(raw.presetId);
  const type = raw.type === 'custom' || (!preset && raw.type !== 'preset') ? 'custom' : 'preset';
  const id = isValidProviderId(raw.id) ? raw.id : generateProviderId(preset ? preset.id : 'c');

  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, LIMITS.nameMax) : '';
  const baseUrlRaw = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, LIMITS.modelMax) : '';
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, LIMITS.apiKeyMax) : '';
  const endpointPath = validateEndpointPath(raw.endpointPath).ok ? String(raw.endpointPath).trim() : '';

  const authHeader =
    typeof raw.authHeader === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(raw.authHeader.trim())
      ? raw.authHeader.trim()
      : DEFAULT_AUTH_HEADER;
  const authScheme =
    typeof raw.authScheme === 'string' && /^[A-Za-z0-9 _.-]{0,32}$/.test(raw.authScheme.trim())
      ? raw.authScheme.trim()
      : DEFAULT_AUTH_SCHEME;

  const now = Date.now();
  const createdAt = Number.isFinite(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now;
  const updatedAt =
    Number.isFinite(raw.updatedAt) && raw.updatedAt > 0
      ? raw.updatedAt
      : options.preserveTimestamps === false
        ? createdAt
        : now;

  return {
    id,
    name: name || (preset ? preset.name : CUSTOM_PROVIDER_DEFAULT_NAME),
    type,
    presetId: preset ? preset.id : null,
    baseUrl: baseUrlRaw.slice(0, LIMITS.baseUrlMax),
    apiKey,
    model,
    endpointPath,
    authHeader,
    authScheme,
    extraHeaders: sanitizeParamObject(raw.extraHeaders),
    params: sanitizeParamObject(raw.params),
    useJsonMode: raw.useJsonMode === true,
    temperature: clampNumber(raw.temperature, 0, 2),
    maxTokens: clampNumber(raw.maxTokens, 1, LIMITS.maxTokensLimit),
    createdAt,
    updatedAt,
  };
}

/**
 * Validate a provider for saving. Missing API keys / models do not block
 * saving (a user may want to fill them in later) — they block *using* it.
 *
 * @returns {{ valid:boolean, errors:Record<string,string>, warnings:string[] }}
 */
export function validateProvider(provider, options = {}) {
  const errors = {};
  const warnings = [];
  const p = isPlainObject(provider) ? provider : {};

  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) errors.name = 'Give this provider a name.';
  else if (name.length > LIMITS.nameMax) errors.name = `Keep the name under ${LIMITS.nameMax} characters.`;

  const urlCheck = validateBaseUrl(p.baseUrl, {
    allowPrivateHttp: options.allowPrivateHttp !== false,
  });
  if (!urlCheck.ok) errors.baseUrl = urlCheck.message;
  else warnings.push(...urlCheck.warnings);

  const model = typeof p.model === 'string' ? p.model.trim() : '';
  if (!model) errors.model = 'Enter a model id, for example gpt-4o-mini.';
  else if (model.length > LIMITS.modelMax) errors.model = 'That model id is too long.';
  else if (/\s{2,}/.test(model)) errors.model = 'Model ids do not contain repeated spaces.';

  const pathCheck = validateEndpointPath(p.endpointPath);
  if (!pathCheck.ok) errors.endpointPath = pathCheck.message;

  if (p.params !== undefined && p.params !== null) {
    if (!isPlainObject(p.params)) errors.params = 'Custom parameters must be a JSON object.';
    else {
      const size = JSON.stringify(p.params).length;
      if (size > LIMITS.paramsBytes) errors.params = 'Custom parameters are too large.';
    }
  }
  if (p.extraHeaders !== undefined && p.extraHeaders !== null) {
    if (!isPlainObject(p.extraHeaders)) errors.extraHeaders = 'Extra headers must be a JSON object.';
    else {
      for (const [k, v] of Object.entries(p.extraHeaders)) {
        if (!/^[A-Za-z0-9-]+$/.test(k)) errors.extraHeaders = `"${k}" is not a valid header name.`;
        else if (typeof v !== 'string' && typeof v !== 'number') {
          errors.extraHeaders = `Header "${k}" must be a string.`;
        }
      }
    }
  }

  const temperature = p.temperature;
  if (temperature !== null && temperature !== undefined && temperature !== '') {
    const t = Number(temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) errors.temperature = 'Temperature must be between 0 and 2.';
  }
  const maxTokens = p.maxTokens;
  if (maxTokens !== null && maxTokens !== undefined && maxTokens !== '') {
    const m = Number(maxTokens);
    if (!Number.isFinite(m) || m < 1 || m > LIMITS.maxTokensLimit) {
      errors.maxTokens = `Max tokens must be between 1 and ${LIMITS.maxTokensLimit}.`;
    }
  }

  if (!urlCheck.ok && urlCheck.code === 'insecure') {
    warnings.push('Plain http:// is limited to local endpoints.');
  }

  return { valid: Object.keys(errors).length === 0, errors, warnings, urlCheck };
}

/** Errors that prevent *running* a request (stronger than saving). */
export function validateProviderForRequest(provider, options = {}) {
  const base = validateProvider(provider, options);
  const errors = { ...base.errors };
  if (!errors.baseUrl) {
    const urlCheck = base.urlCheck;
    const isLocal = urlCheck.ok && urlCheck.isLocal;
    const key = typeof provider?.apiKey === 'string' ? provider.apiKey.trim() : '';
    if (!key && !isLocal) errors.apiKey = 'Add your API key for this provider.';
  }
  return { ...base, valid: Object.keys(errors).length === 0, errors };
}

/** Resolved endpoint, or an error message, for UI display. */
export function resolveEndpoint(provider) {
  try {
    return { ok: true, url: buildChatCompletionsUrl(provider.baseUrl, provider.endpointPath) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Never show a full key in lists or logs. */
export function maskApiKey(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `••••${value.slice(-4)}`;
}

/**
 * The shape sent to the popup. The popup is an extension page (isolated from
 * web pages) and needs the key to edit it, but every *other* message path uses
 * `publicProvider` with the key stripped.
 */
export function providerForPopup(provider) {
  return { ...provider, hasApiKey: Boolean(provider.apiKey) };
}

/** Secret-free shape used for logs, progress messages and the content script. */
export function publicProvider(provider) {
  if (!provider) return null;
  const { apiKey, ...rest } = provider;
  return { ...rest, hasApiKey: Boolean(apiKey) };
}

/** Headers for the request, including the key — never logged, never stored here. */
export function buildRequestHeaders(provider) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const key = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  if (key) {
    const headerName = provider.authHeader || DEFAULT_AUTH_HEADER;
    const scheme = provider.authScheme === undefined ? DEFAULT_AUTH_SCHEME : provider.authScheme;
    headers[headerName] = scheme ? `${scheme} ${key}` : key;
  }
  const extra = isPlainObject(provider.extraHeaders) ? provider.extraHeaders : {};
  for (const [k, v] of Object.entries(extra)) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v);
  }
  return headers;
}
