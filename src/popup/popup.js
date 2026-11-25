/**
 * Fast Tab Agent — popup controller.
 *
 * Owns presentation only. Provider persistence, validation-at-request-time and
 * all network traffic live in the background worker; this file just collects
 * configuration, renders state and routes user intent through runtime messages.
 *
 * API keys never enter the DOM of a web page: this is an extension page, and
 * the key is only ever written into the password/​text input the user is editing
 * (and into the provider record stored under chrome.storage.local).
 */

import { PRESETS, getPreset, isKnownPresetHost } from '../lib/presets.js';
import {
  createProvider,
  validateProvider,
  validateProviderForRequest,
  resolveEndpoint,
  maskApiKey,
} from '../lib/providers.js';
import { displayHost } from '../lib/urls.js';

const $ = (selector, root = document) => root.querySelector(selector);

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ state */

const state = {
  view: 'main',
  providers: [],
  activeId: null,
  permissionOrigins: new Set(),
  settings: { maxSteps: 8, showHud: true, jsonMode: false, allowPrivateHttp: false },
  tab: null,
  task: null,
  draft: null,
  draftIsNew: false,
  dirty: false,
  saving: false,
  saveTimer: null,
  saveState: 'saved',
  rawJson: { params: '', extraHeaders: '' },
  test: { status: 'idle' },
  advancedOpen: false,
  deletePending: false,
  busyStarting: false,
};

const VIEWS = {
  main: $('#viewMain'),
  providers: $('#viewProviders'),
  new: $('#viewNew'),
  editor: $('#viewEditor'),
};

/* -------------------------------------------------------------- messaging */

async function send(type, payload = {}, options = {}) {
  const retries = options.retries ?? 2;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage({ type, ...payload });
      if (!response) throw new Error('The background worker did not respond.');
      if (!response.ok) {
        const error = new Error(response.error?.message || 'Request failed.');
        error.code = response.error?.code;
        error.hint = response.error?.hint;
        error.field = response.error?.field;
        if (error.code === 'host_permission_required') {
          const provider = payload.provider ||
            (payload.id ? state.providers.find((item) => item.id === payload.id) : null) ||
            activeProvider();
          const origin = permissionPattern(provider);
          if (origin) state.permissionOrigins.delete(origin);
        }
        throw error;
      }
      return response.data;
    } catch (error) {
      lastError = error;
      const retryable =
        !error.code && /receiving end does not exist|message port closed|did not respond/i.test(error.message || '');
      if (!retryable || attempt === retries) break;
      await sleep(120);
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ toast */

let toastTimer = null;
function toast(message, tone = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

/* ------------------------------------------------------------------ views */

function showView(name) {
  if (!VIEWS[name]) return;
  state.view = name;
  for (const [key, node] of Object.entries(VIEWS)) node.hidden = key !== name;

  // Keep the covered chrome out of the tab order while a panel is open.
  const overlayOpen = name !== 'main';
  const topbar = $('.topbar');
  if (topbar) topbar.inert = overlayOpen;
  VIEWS.main.inert = overlayOpen;

  if (name === 'editor') {
    setTimeout(() => $('#fName')?.focus({ preventScroll: true }), 30);
  } else if (name === 'providers') {
    setTimeout(() => $('#addProviderBtn')?.focus({ preventScroll: true }), 30);
  } else if (name === 'new') {
    setTimeout(() => $('#customProviderBtn')?.focus({ preventScroll: true }), 30);
  } else {
    setTimeout(() => $('#goalInput')?.focus({ preventScroll: true }), 30);
  }
}

/* ---------------------------------------------------------------- helpers */

function initials(name) {
  const words = String(name || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function providerAccent(provider) {
  const preset = getPreset(provider?.presetId);
  return preset?.accent || '#8b7bff';
}

function hostOf(provider) {
  if (!provider?.baseUrl) return 'No endpoint';
  return displayHost(provider.baseUrl).slice(0, 60);
}

function activeProvider() {
  return state.providers.find((p) => p.id === state.activeId) || null;
}

function permissionPattern(provider) {
  try {
    const url = new URL(provider?.baseUrl || '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

async function refreshPermissionGrants(providers = state.providers) {
  if (!chrome.permissions?.contains) return;
  const origins = new Set(providers.map(permissionPattern).filter(Boolean));
  const granted = new Set();
  for (const origin of origins) {
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) granted.add(origin);
    } catch {
      /* permission status is informational; the worker checks again before fetch */
    }
  }
  state.permissionOrigins = granted;
}

async function ensureEndpointPermission(provider) {
  const origin = permissionPattern(provider);
  if (!origin) throw new Error('Enter a valid HTTP(S) endpoint before connecting.');
  if (state.permissionOrigins.has(origin)) return;
  if (!chrome.permissions?.request) {
    throw new Error('Chrome endpoint permission support is unavailable. Reload the extension and try again.');
  }
  // Called directly from Test, Fetch models, or Run button handlers so Chrome's
  // permission prompt is tied to an explicit user action.
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`Permission to contact ${new URL(provider.baseUrl).host} was not granted.`);
  }
  state.permissionOrigins.add(origin);
}

function isRunnable(provider) {
  if (!provider) return false;
  return validateProviderForRequest(provider, {
    allowPrivateHttp: state.settings.allowPrivateHttp,
  }).valid;
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* -------------------------------------------------------------- header/ui */

function renderChip() {
  const provider = activeProvider();
  const label = $('#chipLabel');
  const dot = $('#chipDot');
  const chip = $('#providerChip');

  if (!provider) {
    label.textContent = 'No provider';
    dot.dataset.state = 'incomplete';
    chip.title = 'Add an AI provider';
  } else {
    label.textContent = provider.name;
    const runnable = isRunnable(provider);
    dot.dataset.state = runnable ? 'ready' : 'incomplete';
    chip.title = `${provider.name} · ${provider.model || 'no model'} — manage providers`;
  }
  renderGoalHint();
}

function renderGoalHint() {
  const hint = $('#goalHint');
  const provider = activeProvider();
  const tab = state.tab;
  let message = '';
  let tone = '';

  if (!provider) {
    message = 'Add an AI provider to start — any OpenAI-compatible endpoint works.';
    tone = 'warn';
  } else if (!provider.apiKey && !isRunnable(provider)) {
    message = `Add an API key for ${provider.name} to run tasks.`;
    tone = 'warn';
  } else if (!provider.model) {
    message = `Set a model id for ${provider.name}.`;
    tone = 'warn';
  } else if (!isRunnable(provider)) {
    const check = validateProvider(provider, { allowPrivateHttp: state.settings.allowPrivateHttp });
    const firstError = Object.values(check.errors)[0];
    message = firstError || 'This provider needs attention.';
    tone = 'error';
  } else if (tab && tab.supported === false) {
    message = 'Open a normal website (http or https) to run the agent.';
    tone = 'warn';
  }

  hint.textContent = message;
  if (tone) hint.dataset.tone = tone;
  else delete hint.dataset.tone;
}

function renderPageTag() {
  const tag = $('#pageTag');
  if (!state.tab || !state.tab.url) {
    tag.hidden = true;
    return;
  }
  try {
    const url = new URL(state.tab.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      tag.hidden = true;
      return;
    }
    tag.textContent = url.host;
    tag.title = state.tab.title || state.tab.url;
    tag.hidden = false;
  } catch {
    tag.hidden = true;
  }
}

/* ------------------------------------------------------------ provider list */

function renderProviderList() {
  const list = $('#providerList');
  list.replaceChildren();
  $('#providerEmpty').hidden = state.providers.length > 0;

  for (const provider of state.providers) {
    const isActive = provider.id === state.activeId;
    const accent = providerAccent(provider);
    const avatar = el('span', {
      class: 'avatar',
      style: { background: `${accent}22`, color: accent, borderColor: `${accent}44` },
      text: initials(provider.name),
    });

    const metaParts = [];
    if (provider.model) metaParts.push(provider.model);
    else metaParts.push('No model set');
    metaParts.push(hostOf(provider));

    const meta = el('span', { class: 'row-meta', text: metaParts.join(' · ') });
    if (provider.baseUrl && !provider.apiKey) {
      try {
        const host = new URL(provider.baseUrl).hostname;
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
        if (!isLocal) {
          meta.textContent = `${metaParts.join(' · ')} · needs key`;
          meta.classList.add('row-warn');
        }
      } catch {
        /* ignore */
      }
    }

    const keyLabel = provider.apiKey ? `key ${maskApiKey(provider.apiKey)}` : 'no API key';
    const openButton = el(
      'button',
      {
        class: 'row-open',
        type: 'button',
        'aria-label': `Edit ${provider.name}`,
        title: `${provider.name} · ${provider.model || 'no model'} · ${keyLabel}`,
        onclick: () => openEditor(provider, { isNew: false }),
      },
      avatar,
      el('span', { class: 'row-text' }, el('strong', { text: provider.name }), meta),
    );

    const stateButton = el('button', {
      class: 'row-state',
      type: 'button',
      text: isActive ? 'Active' : 'Use',
      'aria-pressed': isActive ? 'true' : 'false',
      'aria-label': isActive ? `${provider.name} is active` : `Make ${provider.name} the active provider`,
      onclick: async (event) => {
        event.stopPropagation();
        if (isActive) {
          openEditor(provider, { isNew: false });
          return;
        }
        await activateProvider(provider.id);
      },
    });

    list.append(el('li', { class: 'provider-row', dataset: { active: String(isActive) } }, openButton, stateButton));
  }
}

function renderPresetGrid() {
  const grid = $('#presetGrid');
  grid.replaceChildren();
  for (const preset of PRESETS) {
    const avatar = el('span', {
      class: 'avatar',
      style: { background: `${preset.accent}22`, color: preset.accent, borderColor: `${preset.accent}44` },
      text: initials(preset.name),
    });
    grid.append(
      el(
        'li',
        {},
        el(
          'button',
          {
            class: 'preset',
            type: 'button',
            onclick: () => startNewProvider(preset),
            'aria-label': `Add ${preset.name}`,
          },
          avatar,
          el(
            'span',
            { class: 'preset-text' },
            el('strong', { text: preset.name }),
            el('span', { text: preset.tagline }),
          ),
        ),
      ),
    );
  }
}

async function activateProvider(id) {
  try {
    const data = await send('providers:activate', { id });
    state.activeId = data.activeId || id;
    renderProviderList();
    renderChip();
    renderEditorActiveState();
    const provider = state.providers.find((p) => p.id === state.activeId);
    toast(`${provider?.name || 'Provider'} is now active`);
    return true;
  } catch (error) {
    toast(error.message || 'Could not activate that provider.', 'error');
    return false;
  }
}

/* ------------------------------------------------------------------- add */

function startNewProvider(preset) {
  const draft = preset ? createProvider(preset.id) : createProvider(null);
  openEditor(draft, { isNew: true });
}

/* ---------------------------------------------------------------- editor */

const FIELD_IDS = [
  'fName',
  'fBaseUrl',
  'fModel',
  'fApiKey',
  'fEndpointPath',
  'fAuthHeader',
  'fAuthScheme',
  'fTemperature',
  'fMaxTokens',
  'fUseJsonMode',
  'fParams',
  'fExtraHeaders',
];

function openEditor(provider, { isNew }) {
  state.draft = {
    ...provider,
    params: { ...(provider.params || {}) },
    extraHeaders: { ...(provider.extraHeaders || {}) },
  };
  state.draftIsNew = Boolean(isNew);
  state.dirty = false;
  state.deletePending = false;
  state.test = { status: 'idle' };
  state.rawJson = {
    params: Object.keys(state.draft.params).length ? JSON.stringify(state.draft.params, null, 2) : '',
    extraHeaders: Object.keys(state.draft.extraHeaders).length
      ? JSON.stringify(state.draft.extraHeaders, null, 2)
      : '',
  };

  const preset = getPreset(state.draft.presetId);
  $('#fName').value = state.draft.name || '';
  $('#fBaseUrl').value = state.draft.baseUrl || '';
  $('#fModel').value = state.draft.model || '';
  $('#fModel').placeholder = preset?.modelHint || 'model-id';
  $('#fApiKey').value = state.draft.apiKey || '';
  $('#fEndpointPath').value = state.draft.endpointPath || '';
  $('#fAuthHeader').value = state.draft.authHeader || '';
  $('#fAuthScheme').value = state.draft.authScheme ?? '';
  $('#fTemperature').value = state.draft.temperature ?? '';
  $('#fMaxTokens').value = state.draft.maxTokens ?? '';
  $('#fUseJsonMode').checked = state.draft.useJsonMode === true;
  $('#fParams').value = state.rawJson.params;
  $('#fExtraHeaders').value = state.rawJson.extraHeaders;
  $('#fApiKey').type = 'password';
  $('#toggleKey').setAttribute('aria-pressed', 'false');
  $('#toggleKey').setAttribute('aria-label', 'Show API key');
  $('#deleteConfirm').hidden = true;
  $('#testResult').hidden = true;
  $('#modelList').hidden = true;
  $('#editorTitle').textContent = isNew ? 'New provider' : state.draft.name || 'Edit provider';

  setAdvanced(state.advancedOpen);
  clearFieldErrors();
  renderEditor();
  setSaveState(isNew ? 'dirty' : 'saved', isNew ? 'Not saved yet' : 'All changes saved');
  showView('editor');
}

function renderEditor() {
  if (!state.draft) return;
  const draft = state.draft;
  $('#editorSub').textContent = draft.model ? `${draft.model} · ${hostOf(draft)}` : 'OpenAI-compatible chat completions';
  $('#editorActivePill').hidden = draft.id !== state.activeId;
  $('#activateBtn').textContent =
    draft.id === state.activeId ? 'Active provider' : 'Use this provider';
  $('#activateBtn').disabled = draft.id === state.activeId;
  $('#deleteBtn').hidden = false;

  renderEndpointPreview();
  renderCustomWarning();
  renderTestResult();
}

function renderEditorActiveState() {
  if (state.view !== 'editor' || !state.draft) return;
  renderEditor();
}

function renderEndpointPreview() {
  const node = $('#endpointPreview');
  const draft = state.draft;
  if (!draft) return;
  if (!draft.baseUrl) {
    node.textContent = 'Requests will POST to <base URL> + /chat/completions.';
    delete node.dataset.tone;
    return;
  }
  const resolved = resolveEndpoint(draft);
  if (resolved.ok) {
    const insecure = resolved.url.startsWith('http://');
    node.textContent = insecure
      ? `POST ${resolved.url} — plain HTTP, local endpoints only`
      : `POST ${resolved.url}`;
    node.dataset.tone = insecure ? 'warn' : 'ok';
  } else {
    node.textContent = resolved.error;
    node.dataset.tone = 'warn';
  }
}

function renderCustomWarning() {
  const banner = $('#customWarning');
  const text = $('#customWarningText');
  const draft = state.draft;
  if (!draft) {
    banner.hidden = true;
    return;
  }
  let host = '';
  try {
    host = new URL(draft.baseUrl).host;
  } catch {
    host = '';
  }
  const known = host ? isKnownPresetHost(host) : false;
  if (draft.type === 'custom' || (host && !known)) {
    banner.hidden = false;
    text.textContent = host
      ? `Your API key will be sent to ${host}. Only use endpoints you trust.`
      : 'Enter a base URL you trust. Your API key is sent only to that endpoint.';
  } else {
    banner.hidden = true;
  }
}

function setAdvanced(open) {
  state.advancedOpen = Boolean(open);
  $('#advancedBody').hidden = !state.advancedOpen;
  $('#advancedToggle').setAttribute('aria-expanded', String(state.advancedOpen));
}

/* ---------------------------------------------------------------- saving */

function setSaveState(kind, text) {
  state.saveState = kind;
  const node = $('#saveState');
  node.dataset.state = kind;
  const labels = {
    saving: 'Saving…',
    saved: text || 'All changes saved',
    dirty: text || 'Not saved',
    error: text || 'Not saved',
  };
  $('#saveStateText').textContent = labels[kind] || '';
}

function clearFieldErrors() {
  for (const id of ['errName', 'errBaseUrl', 'errModel', 'errEndpointPath', 'errTemperature', 'errMaxTokens', 'errParams', 'errExtraHeaders', 'errApiKey']) {
    const node = $(`#${id}`);
    if (!node) continue;
    node.hidden = true;
    node.textContent = '';
  }
  for (const id of FIELD_IDS) {
    const field = $(`#${id}`);
    if (field) field.dataset.invalid = 'false';
  }
}

function setFieldError(key, message) {
  const map = {
    name: ['errName', 'fName'],
    baseUrl: ['errBaseUrl', 'fBaseUrl'],
    model: ['errModel', 'fModel'],
    apiKey: ['errApiKey', 'fApiKey'],
    endpointPath: ['errEndpointPath', 'fEndpointPath'],
    temperature: ['errTemperature', 'fTemperature'],
    maxTokens: ['errMaxTokens', 'fMaxTokens'],
    params: ['errParams', 'fParams'],
    extraHeaders: ['errExtraHeaders', 'fExtraHeaders'],
  };
  const target = map[key];
  if (!target) return;
  const errorNode = $(`#${target[0]}`);
  const fieldNode = $(`#${target[1]}`);
  if (message) {
    errorNode.textContent = message;
    errorNode.hidden = false;
    if (fieldNode) fieldNode.dataset.invalid = 'true';
  } else {
    errorNode.hidden = true;
    errorNode.textContent = '';
    if (fieldNode) fieldNode.dataset.invalid = 'false';
  }
}

function parseJsonField(text, label) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, message: `${label} must be a JSON object.` };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: `Invalid JSON — ${error.message}` };
  }
}

function readFormIntoDraft() {
  const draft = state.draft;
  if (!draft) return;
  draft.name = $('#fName').value;
  draft.baseUrl = $('#fBaseUrl').value.trim();
  draft.model = $('#fModel').value.trim();
  draft.apiKey = $('#fApiKey').value.trim();
  draft.endpointPath = $('#fEndpointPath').value.trim();
  draft.authHeader = $('#fAuthHeader').value.trim() || 'Authorization';
  draft.authScheme = $('#fAuthScheme').value.trim();
  draft.useJsonMode = $('#fUseJsonMode').checked;

  const temperature = $('#fTemperature').value.trim();
  draft.temperature = temperature === '' ? null : Number(temperature);
  const maxTokens = $('#fMaxTokens').value.trim();
  draft.maxTokens = maxTokens === '' ? null : Number(maxTokens);

  state.rawJson.params = $('#fParams').value;
  state.rawJson.extraHeaders = $('#fExtraHeaders').value;

  const params = parseJsonField(state.rawJson.params, 'Custom parameters');
  const headers = parseJsonField(state.rawJson.extraHeaders, 'Extra headers');
  draft.params = params.ok ? params.value : draft.params;
  draft.extraHeaders = headers.ok ? headers.value : draft.extraHeaders;

  draft.__json = {
    params: params.ok ? null : params.message,
    extraHeaders: headers.ok ? null : headers.message,
  };
}

function validateDraft() {
  const draft = state.draft;
  if (!draft) return { valid: false, errors: {}, warnings: [] };
  const check = validateProvider(draft, { allowPrivateHttp: state.settings.allowPrivateHttp });

  // JSON textareas have their own messages.
  if (draft.__json?.params) check.errors.params = draft.__json.params;
  if (draft.__json?.extraHeaders) check.errors.extraHeaders = draft.__json.extraHeaders;

  // A missing key blocks running, not saving.
  if (draft.apiKey) delete check.errors.apiKey;

  return { ...check, valid: Object.keys(check.errors).length === 0 };
}

function renderValidation() {
  const { errors } = validateDraft();
  for (const key of ['name', 'baseUrl', 'model', 'endpointPath', 'temperature', 'maxTokens', 'params', 'extraHeaders']) {
    setFieldError(key, errors[key] || '');
  }
  renderEndpointPreview();
  renderCustomWarning();

  const draft = state.draft;
  if (draft) {
    $('#editorTitle').textContent = state.draftIsNew ? 'New provider' : draft.name || 'Edit provider';
    $('#editorSub').textContent = draft.model ? `${draft.model} · ${hostOf(draft)}` : 'OpenAI-compatible chat completions';
  }
}

function canAutosave() {
  const draft = state.draft;
  if (!draft) return false;
  if (!String(draft.name || '').trim()) return false;
  if (draft.__json?.params || draft.__json?.extraHeaders) return false;
  if (draft.baseUrl) {
    const { errors } = validateDraft();
    // Hard URL errors (scheme, credentials) block saving; empty URL is fine.
    if (errors.baseUrl) return false;
  }
  return true;
}

function scheduleSave() {
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    void saveDraft();
  }, 650);
  if (state.saveState !== 'saving') setSaveState('dirty', 'Unsaved changes');
}

async function saveDraft(options = {}) {
  const draft = state.draft;
  if (!draft) return null;
  if (state.saving) {
    // A save is in flight with older data — run again once it settles.
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      void saveDraft();
    }, 250);
    return null;
  }
  clearTimeout(state.saveTimer);

  if (!canAutosave()) {
    if (options.force) {
      setSaveState('error', 'Fix the highlighted fields');
      const { errors } = validateDraft();
      const first = Object.values(errors)[0];
      if (first) toast(first, 'error');
    } else {
      setSaveState('dirty', 'Not saved');
    }
    return null;
  }

  state.saving = true;
  setSaveState('saving', 'Saving…');
  try {
    const payload = {
      id: draft.id,
      name: String(draft.name || '').trim(),
      type: draft.type,
      presetId: draft.presetId || null,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
      model: draft.model,
      endpointPath: draft.endpointPath,
      authHeader: draft.authHeader,
      authScheme: draft.authScheme,
      extraHeaders: draft.extraHeaders,
      params: draft.params,
      useJsonMode: draft.useJsonMode,
      temperature: draft.temperature,
      maxTokens: draft.maxTokens,
      createdAt: draft.createdAt,
    };
    const data = await send('providers:save', { provider: payload });

    // Adopt server-assigned identity/timestamps, but never rewrite the
    // user's in-progress input.
    draft.id = data.provider.id;
    draft.createdAt = data.provider.createdAt;
    draft.updatedAt = data.provider.updatedAt;
    draft.type = data.provider.type;
    draft.presetId = data.provider.presetId;
    state.draftIsNew = false;
    state.dirty = false;
    state.activeId = data.activeId || state.activeId;

    const index = state.providers.findIndex((item) => item.id === data.provider.id);
    if (index >= 0) state.providers[index] = data.provider;
    else state.providers.push(data.provider);

    setSaveState('saved', `Saved · ${timeNow()}`);
    renderProviderList();
    renderChip();
    renderEditor();
    return data.provider;
  } catch (error) {
    setSaveState('error', 'Not saved');
    if (error.field) setFieldError(error.field, error.message);
    toast(error.message || 'Could not save this provider.', 'error');
    return null;
  } finally {
    state.saving = false;
  }
}

/* ------------------------------------------------------------------ test */

const TEST_UI = {
  success: { tone: 'success', title: 'Connection successful' },
  auth_failed: { tone: 'error', title: 'Authentication failed' },
  model_unavailable: { tone: 'error', title: 'Model unavailable' },
  rate_limited: { tone: 'warn', title: 'Rate limited' },
  insufficient_quota: { tone: 'error', title: 'Quota exceeded' },
  connection_failed: { tone: 'error', title: 'Connection failed' },
  timeout: { tone: 'error', title: 'Connection timed out' },
  unsupported_endpoint: { tone: 'error', title: 'Unsupported endpoint' },
  invalid_config: { tone: 'warn', title: 'Check the configuration' },
  invalid_response: { tone: 'error', title: 'Unexpected response' },
  server_error: { tone: 'error', title: 'Provider server error' },
  http_error: { tone: 'error', title: 'Request failed' },
  cancelled: { tone: 'warn', title: 'Test cancelled' },
  testing: { tone: 'busy', title: 'Testing connection…' },
};

function renderTestResult() {
  const node = $('#testResult');
  const test = state.test || { status: 'idle' };
  if (test.status === 'idle') {
    node.hidden = true;
    node.replaceChildren();
    return;
  }
  const ui = TEST_UI[test.status] || TEST_UI.http_error;
  node.hidden = false;
  node.dataset.tone = ui.tone;
  node.replaceChildren();

  const head = el('div', { class: 'tr-head' });
  if (test.status === 'testing') head.append(el('span', { class: 'spinner' }));
  head.append(el('span', { text: ui.title }));
  node.append(head);

  if (test.status !== 'testing') {
    if (test.message) node.append(el('div', { class: 'tr-detail', text: test.message }));
    if (test.providerMessage && test.providerMessage !== test.message) {
      node.append(el('div', { class: 'tr-detail', text: test.providerMessage }));
    }
    if (test.hint) node.append(el('div', { class: 'tr-detail', text: test.hint }));
    if (test.reply) node.append(el('div', { class: 'tr-detail', text: `Model replied: “${test.reply}”` }));

    const meta = [];
    if (test.host) meta.push(test.host);
    if (test.model) meta.push(test.model);
    if (typeof test.latencyMs === 'number' && test.latencyMs > 0) meta.push(`${test.latencyMs} ms`);
    if (test.httpStatus) meta.push(`HTTP ${test.httpStatus}`);
    if (meta.length) node.append(el('div', { class: 'tr-meta', text: meta.join(' · ') }));
  }
}

async function testProviderConnection() {
  if (!state.draft || state.test.status === 'testing') return;
  readFormIntoDraft();
  renderValidation();

  const params = parseJsonField(state.rawJson.params, 'Custom parameters');
  const headers = parseJsonField(state.rawJson.extraHeaders, 'Extra headers');
  if (!params.ok || !headers.ok) {
    state.test = {
      status: 'invalid_config',
      message: !params.ok ? params.message : headers.message,
      hint: 'Fix the JSON above, then test again.',
    };
    renderTestResult();
    return;
  }

  state.test = { status: 'testing' };
  renderTestResult();
  const button = $('#testBtn');
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = 'Testing…';

  try {
    await ensureEndpointPermission(state.draft);
    const result = await send('providers:test', {
      provider: {
        ...state.draft,
        params: params.value,
        extraHeaders: headers.value,
      },
    });
    state.test = result;
  } catch (error) {
    state.test = {
      status: error.code === 'invalid_config' ? 'invalid_config' : 'connection_failed',
      message: error.message,
      hint: error.hint,
    };
  } finally {
    button.disabled = false;
    button.textContent = originalText;
    renderTestResult();
  }
}

/* ------------------------------------------------- optional: model lists */

async function fetchModels() {
  if (!state.draft) return;
  readFormIntoDraft();
  const list = $('#modelList');
  const button = $('#fetchModelsBtn');
  if (!state.draft.baseUrl) {
    toast('Add a base URL first.', 'error');
    $('#fBaseUrl').focus();
    return;
  }

  const params = parseJsonField(state.rawJson.params, 'Custom parameters');
  const headers = parseJsonField(state.rawJson.extraHeaders, 'Extra headers');
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Loading…';

  try {
    await ensureEndpointPermission(state.draft);
    const data = await send('providers:models', {
      provider: {
        ...state.draft,
        params: params.ok ? params.value : {},
        extraHeaders: headers.ok ? headers.value : {},
      },
    });
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) {
      list.hidden = true;
      toast('No models returned — type the model id manually.');
      return;
    }
    list.replaceChildren();
    for (const id of models.slice(0, 300)) {
      list.append(
        el('button', {
          class: 'model-option',
          type: 'button',
          text: id,
          title: id,
          onclick: () => {
            $('#fModel').value = id;
            readFormIntoDraft();
            renderValidation();
            scheduleSave();
            list.hidden = true;
            $('#fModel').focus({ preventScroll: true });
          },
        }),
      );
    }
    list.hidden = false;
    toast(`${models.length} model${models.length === 1 ? '' : 's'} found`);
  } catch (error) {
    list.hidden = true;
    toast(
      error.message || 'Model discovery is not supported here — just type the model id.',
      'error',
    );
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* -------------------------------------------------------------- task view */

function taskStatusLabel(task) {
  if (!task) return { label: 'Ready', state: 'idle' };
  switch (task.status) {
    case 'running':
      return { label: 'Working', state: 'running' };
    case 'done':
      return { label: task.limitReached ? 'Step limit reached' : 'Complete', state: 'done' };
    case 'stopped':
      return { label: 'Stopped', state: 'stopped' };
    case 'error':
      return { label: 'Stopped', state: 'error' };
    default:
      return { label: 'Ready', state: 'idle' };
  }
}

function renderTask() {
  const task = state.task;
  const section = $('#runSection');
  const tips = $('#tips');
  const runBtn = $('#runBtn');
  const stopBtn = $('#stopBtn');
  const running = task?.status === 'running';

  if (!task) {
    section.hidden = true;
    tips.hidden = false;
    runBtn.hidden = false;
    runBtn.disabled = state.busyStarting;
    stopBtn.hidden = true;
    $('#runBtnLabel').textContent = state.busyStarting ? 'Starting…' : 'Run agent';
    $('#runMeta').textContent = '';
    return;
  }

  section.hidden = false;
  tips.hidden = true;
  runBtn.disabled = running || state.busyStarting;
  runBtn.hidden = running;
  stopBtn.hidden = !running;
  $('#runBtnLabel').textContent = state.busyStarting ? 'Starting…' : 'Run agent';

  const status = taskStatusLabel(task);
  const statusNode = $('#runStatus');
  statusNode.textContent = status.label;
  statusNode.dataset.state = status.state;

  const steps = Array.isArray(task.steps) ? task.steps : [];
  const progressNode = $('#runProgress');
  if (running) {
    progressNode.textContent = `Step ${Math.max(1, steps.length || 1)} / ${task.maxSteps || '—'}`;
  } else {
    progressNode.textContent = `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  }

  $('#runGoal').textContent = task.goal || '';
  $('#runMeta').textContent = task.provider ? task.provider.model || task.provider.name : '';

  const timeline = $('#timeline');
  timeline.replaceChildren();
  for (const step of steps.slice(-24)) {
    const dotState = step.ok === false ? 'false' : 'true';
    const item = el('li', { class: 'step', dataset: { ok: dotState } });
    item.append(
      el(
        'div',
        { class: 'step-top' },
        el('span', { class: 'step-desc', text: `${step.step}. ${step.description || 'action'}` }),
        el('span', { class: 'step-badge', text: step.ok === false ? 'failed' : step.done ? 'done' : 'ok' }),
      ),
    );
    if (step.thought) item.append(el('p', { class: 'step-thought', text: step.thought }));
    if (step.observation && !step.done) item.append(el('p', { class: 'step-obs', text: step.observation }));
    timeline.append(item);
  }

  if (running && steps.length === 0) {
    const item = el('li', { class: 'step', dataset: { ok: 'pending' } });
    item.append(
      el('div', { class: 'step-top' }, el('span', { class: 'step-desc', text: 'Reading the page…' })),
    );
    timeline.append(item);
  }

  const answer = $('#runAnswer');
  if (task.status === 'error' && task.error) {
    answer.hidden = false;
    answer.dataset.tone = 'error';
    answer.textContent = [task.error.message, task.error.hint].filter(Boolean).join('\n');
  } else if (!running && task.answer) {
    answer.hidden = false;
    answer.dataset.tone =
      task.status === 'stopped' ? 'muted' : task.limitReached ? 'warn' : 'success';
    answer.textContent = task.answer;
  } else {
    answer.hidden = true;
    answer.textContent = '';
    delete answer.dataset.tone;
  }

  if (running) {
    requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }
}

async function startTask() {
  const goal = $('#goalInput').value.trim();
  if (!goal) {
    $('#goalInput').focus();
    $('#goalHint').textContent = 'Describe what the agent should do on this page.';
    $('#goalHint').dataset.tone = 'warn';
    return;
  }
  state.busyStarting = true;
  renderTask();
  const hint = $('#goalHint');
  hint.textContent = '';
  delete hint.dataset.tone;

  try {
    const provider = activeProvider();
    if (provider) await ensureEndpointPermission(provider);
    const task = await send('task:start', { goal });
    state.task = task;
    renderTask();
  } catch (error) {
    hint.textContent = [error.message, error.hint].filter(Boolean).join(' ');
    hint.dataset.tone = 'error';
    // Refresh provider config in case the error came from a stale record.
    void refreshProviders();
  } finally {
    state.busyStarting = false;
    renderTask();
  }
}

async function stopTask() {
  try {
    const data = await send('task:stop');
    if (data?.task) {
      state.task = data.task;
      renderTask();
    }
  } catch (error) {
    toast(error.message || 'Could not stop the task.', 'error');
  }
}

/* ------------------------------------------------------------ preferences */

function renderPreferences() {
  $('#prefMaxSteps').value = state.settings.maxSteps ?? 8;
  $('#prefShowHud').checked = state.settings.showHud !== false;
  $('#prefJsonMode').checked = state.settings.jsonMode === true;
  $('#prefPrivateHttp').checked = state.settings.allowPrivateHttp === true;
}

async function savePreferences(patch) {
  try {
    const data = await send('settings:save', { settings: patch });
    state.settings = { ...state.settings, ...data.settings };
    renderPreferences();
    renderGoalHint();
    toast('Preferences saved');
  } catch (error) {
    toast(error.message || 'Could not save preferences.', 'error');
  }
}

/* ------------------------------------------------------------------ boot */

async function refreshProviders() {
  try {
    const data = await send('providers:list');
    state.providers = data.providers || [];
    state.activeId = data.activeId || state.providers[0]?.id || null;
    await refreshPermissionGrants(state.providers);
    renderProviderList();
    renderChip();
  } catch (error) {
    toast(error.message || 'Could not load providers.', 'error');
  }
}

async function refreshAppInfo() {
  try {
    const data = await send('app:info');
    state.settings = { ...state.settings, ...(data.settings || {}) };
    state.tab = data.tab;
    state.task = data.task || state.task;
    renderPageTag();
    renderPreferences();
    renderTask();
    renderGoalHint();
  } catch (error) {
    toast(error.message || 'Could not read the current tab.', 'error');
  }
}

async function refreshTaskState() {
  try {
    const task = await send('task:state');
    if (task) {
      state.task = task;
      renderTask();
    }
  } catch {
    /* not fatal */
  }
}

function bindEvents() {
  $('#providerChip').addEventListener('click', () => {
    renderProviderList();
    showView('providers');
  });
  $('#providersBack').addEventListener('click', () => showView('main'));
  $('#providersDone').addEventListener('click', () => showView('main'));
  $('#addProviderBtn').addEventListener('click', () => showView('new'));
  $('#newBack').addEventListener('click', () => showView('providers'));
  $('#customProviderBtn').addEventListener('click', () => startNewProvider(null));

  $('#editorBack').addEventListener('click', async () => {
    if (state.dirty) {
      const saved = await saveDraft();
      if (!saved) toast('Some fields need attention — fix the highlighted errors to save.', 'error');
    }
    renderProviderList();
    showView('providers');
  });

  $('#runBtn').addEventListener('click', startTask);
  $('#stopBtn').addEventListener('click', stopTask);

  $('#goalInput').addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!$('#runBtn').disabled) startTask();
    }
  });

  // Editor field plumbing.
  const onEdit = () => {
    readFormIntoDraft();
    renderValidation();
    scheduleSave();
  };
  for (const id of FIELD_IDS) {
    const field = $(`#${id}`);
    if (!field) continue;
    field.addEventListener('input', onEdit);
    field.addEventListener('change', onEdit);
    field.addEventListener('blur', () => {
      if (state.dirty) void saveDraft();
    });
  }

  $('#toggleKey').addEventListener('click', () => {
    const input = $('#fApiKey');
    const button = $('#toggleKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    input.focus({ preventScroll: true });
  });

  $('#advancedToggle').addEventListener('click', () => setAdvanced(!state.advancedOpen));

  $('#testBtn').addEventListener('click', testProviderConnection);
  $('#fetchModelsBtn').addEventListener('click', fetchModels);
  $('#forgetEndpointPermission').addEventListener('click', async () => {
    const provider = state.draft;
    const origin = permissionPattern(provider);
    if (!origin || !chrome.permissions?.remove) {
      toast('This endpoint does not have removable HTTP(S) host access.', 'warn');
      return;
    }
    try {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      state.permissionOrigins.delete(origin);
      toast(removed ? `Access to ${new URL(provider.baseUrl).host} was removed.` : 'No permission grant was found.');
    } catch {
      toast('Chrome could not remove this host permission.', 'error');
    }
  });
  $('#fModel').addEventListener('input', () => {
    $('#modelList').hidden = true;
  });

  $('#activateBtn').addEventListener('click', async () => {
    if (!state.draft) return;
    if (state.dirty || state.draftIsNew) {
      const saved = await saveDraft({ force: true });
      if (!saved) return;
    }
    const ok = await activateProvider(state.draft.id);
    if (ok) {
      renderEditor();
      setSaveState('saved', 'Saved & active');
    }
  });

  $('#deleteBtn').addEventListener('click', () => {
    state.deletePending = true;
    $('#deleteConfirm').hidden = false;
    $('#deleteConfirmBtn').focus({ preventScroll: true });
  });
  $('#deleteCancel').addEventListener('click', () => {
    state.deletePending = false;
    $('#deleteConfirm').hidden = true;
    $('#deleteBtn').focus({ preventScroll: true });
  });
  $('#deleteConfirmBtn').addEventListener('click', async () => {
    if (!state.draft) return;
    const id = state.draft.id;
    const isSaved = state.providers.some((p) => p.id === id);
    clearTimeout(state.saveTimer);
    state.dirty = false;
    try {
      if (isSaved) {
        const data = await send('providers:delete', { id });
        state.activeId = data.activeId || null;
      }
      state.providers = state.providers.filter((p) => p.id !== id);
      state.draft = null;
      state.draftIsNew = false;
      state.deletePending = false;
      renderProviderList();
      renderChip();
      renderTask();
      showView('providers');
      toast('Provider deleted');
    } catch (error) {
      toast(error.message || 'Could not delete this provider.', 'error');
    }
  });

  // Preferences
  $('#prefMaxSteps').addEventListener('change', () => {
    const value = Number($('#prefMaxSteps').value);
    void savePreferences({ maxSteps: Number.isFinite(value) ? value : 8 });
  });
  $('#prefShowHud').addEventListener('change', () =>
    savePreferences({ showHud: $('#prefShowHud').checked }),
  );
  $('#prefJsonMode').addEventListener('change', () =>
    savePreferences({ jsonMode: $('#prefJsonMode').checked }),
  );
  $('#prefPrivateHttp').addEventListener('change', () =>
    savePreferences({ allowPrivateHttp: $('#prefPrivateHttp').checked }),
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.view === 'editor') {
        event.preventDefault();
        $('#editorBack').click();
      } else if (state.view === 'new') {
        showView('providers');
      } else if (state.view === 'providers') {
        showView('main');
      }
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'fta:progress' && message.task) {
      state.task = message.task;
      renderTask();
      if (message.task.status !== 'running') {
        void refreshProviders();
      }
    }
    return false;
  });
}

async function init() {
  bindEvents();
  renderPresetGrid();
  renderChip();
  renderTask();

  await Promise.all([refreshProviders(), refreshAppInfo()]);
  await refreshTaskState();

  if (!state.providers.length) {
    showView('new');
  } else {
    showView('main');
  }
  if (!state.task || state.task.status !== 'running') {
    $('#goalInput').focus({ preventScroll: true });
  }
}

void init();
