/**
 * Fast Tab Agent — background service worker.
 *
 * Responsibilities:
 *  - own provider configuration storage (chrome.storage.local, one record per
 *    provider) and the active provider pointer;
 *  - validate endpoints and perform *all* AI network requests;
 *  - expose a small chrome.runtime message API to the popup;
 *  - run the agent loop against the active tab via the page agent.
 *
 * The popup and content script never call a provider directly, and the API key
 * never leaves this worker except inside an Authorization header.
 */

import { createProviderStore } from './lib/provider-store.js';
import { chatCompletion, testConnection, listModels } from './lib/api.js';
import {
  normalizeProvider,
  providerForPopup,
  publicProvider,
  validateProvider,
  validateProviderForRequest,
} from './lib/providers.js';
import { DEFAULT_SETTINGS, LIMITS, STORAGE_KEYS, TASK_STORAGE_KEY, TASK_STATUS } from './lib/constants.js';
import { ERROR_CODES, ProviderError, friendlyError } from './lib/errors.js';
import { runAgentTask } from './lib/agent-runner.js';

// chrome.storage.local is readable by untrusted contexts by default on some
// Chrome versions. Fail closed unless API-key storage is restricted before any
// provider record is read or any page agent is injected.
const store = createProviderStore(chrome.storage.local);
let initPromise = null;
let storageAccessPromise = null;

function lockStorageAccess() {
  if (!storageAccessPromise) {
    storageAccessPromise = (async () => {
      if (typeof chrome.storage.local.setAccessLevel !== 'function') {
        throw new Error('Secure extension storage access is unavailable in this Chrome version.');
      }
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      if (chrome.storage.session?.setAccessLevel) {
        await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      }
    })();
  }
  return storageAccessPromise;
}

function ensureInit() {
  if (!initPromise) {
    initPromise = lockStorageAccess()
      .then(() => store.ensureInitialised())
      .catch((error) => {
        initPromise = null;
        console.warn('Fast Tab Agent: secure provider store initialization failed.');
        throw error;
      });
  }
  return initPromise;
}

/* ------------------------------------------------------------- settings -- */

function sanitizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const settings = { ...DEFAULT_SETTINGS };
  const steps = Number(source.maxSteps);
  if (Number.isFinite(steps)) {
    settings.maxSteps = Math.min(LIMITS.maxSteps, Math.max(LIMITS.minSteps, Math.round(steps)));
  }
  if (source.temperature === null || source.temperature === '') {
    settings.temperature = null;
  } else if (source.temperature !== undefined) {
    const t = Number(source.temperature);
    settings.temperature = Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : null;
  }
  const maxTokens = Number(source.maxTokens);
  if (Number.isFinite(maxTokens)) {
    settings.maxTokens = Math.min(LIMITS.maxTokensLimit, Math.max(32, Math.round(maxTokens)));
  }
  for (const key of ['jsonMode', 'allowPrivateHttp', 'showHud']) {
    if (typeof source[key] === 'boolean') settings[key] = source[key];
  }
  return settings;
}

async function getSettings() {
  try {
    const bag = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return sanitizeSettings(bag?.[STORAGE_KEYS.settings]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = sanitizeSettings({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/* ---------------------------------------------------------------- tasks -- */

/** @type {null | {id:string, goal:string, status:string, steps:any[], startedAt:number,
 *                finishedAt:number|null, answer:string, error:any, maxSteps:number,
 *                provider:{id:string,name:string,model:string}|null, tabId:number|null,
 *                limitReached:boolean, phase:string}} */
let currentTask = null;
let abortController = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Convert a validated endpoint to the narrowest Chrome origin grant we can ask for. */
function providerOriginPattern(provider, allowPrivateHttp) {
  const checked = validateProvider(provider, { allowPrivateHttp });
  if (!checked.urlCheck?.ok) {
    throw new ProviderError(ERROR_CODES.invalid_config, checked.urlCheck?.message || 'Invalid endpoint.');
  }
  const url = checked.urlCheck.url;
  return `${url.protocol}//${url.hostname}/*`;
}

async function requireProviderHostPermission(provider, allowPrivateHttp) {
  const origin = providerOriginPattern(provider, allowPrivateHttp);
  if (!chrome.permissions?.contains || !(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new ProviderError(
      'host_permission_required',
      `Allow Fast Tab Agent to contact ${new URL(provider.baseUrl).host}. Grant access in the popup and try again.`,
      { hint: 'Chrome asks for access only when you test or use this endpoint.' },
    );
  }
  return origin;
}

function publicTask(task = currentTask) {
  if (!task) return null;
  return {
    id: task.id,
    goal: task.goal,
    status: task.status,
    phase: task.phase,
    steps: task.steps,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    answer: task.answer,
    error: task.error,
    maxSteps: task.maxSteps,
    limitReached: task.limitReached,
    provider: task.provider,
    tabId: task.tabId,
  };
}

async function persistTask() {
  const snapshot = publicTask();
  try {
    if (snapshot) await chrome.storage.session.set({ [TASK_STORAGE_KEY]: snapshot });
    else await chrome.storage.session.remove(TASK_STORAGE_KEY);
  } catch {
    /* session storage is a convenience, never a requirement */
  }
}

function broadcast(task) {
  try {
    const result = chrome.runtime.sendMessage({ type: 'fta:progress', task: publicTask(task) });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* popup closed */
  }
}

function pushStep(entry) {
  if (!currentTask) return;
  currentTask.steps.push(entry);
  if (currentTask.steps.length > 60) currentTask.steps.splice(0, currentTask.steps.length - 60);
}

let hudEnabled = true;

async function sendHud(tabId, state) {
  if (!tabId || !hudEnabled) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fta:hud', state });
  } catch {
    /* tab closed or navigated: non-fatal */
  }
}

/* -------------------------------------------------------------- tabs/CS -- */

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) return tab;
  } catch {
    /* fall through */
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'fta:ping' });
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function ensureInjected(tabId) {
  if (await pingTab(tabId)) return true;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['src/content/agent.js'],
    });
  } catch {
    throw new Error(
      'Fast Tab Agent cannot read this page. Open a normal http(s) website and try again.',
    );
  }
  const ready = await pingTab(tabId);
  if (!ready) throw new Error('The page agent did not start on this tab.');
  return true;
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await ensureInjected(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/**
 * Wait until a navigation triggered by the page agent has settled.
 *
 * The page agent acknowledges the action and navigates a tick later, so polling
 * `status` immediately would still see the *old* page as "complete". We wait a
 * short grace period, then require either a loading phase, a URL change, or a
 * generous timeout before accepting "complete".
 */
async function waitForTabSettled(tabId, previousUrl, timeoutMs = 9000) {
  const startedAt = Date.now();
  await sleep(350);
  let sawLoading = false;

  while (Date.now() - startedAt < timeoutMs) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return false;
    }
    if (!tab) return false;
    if (tab.status === 'loading') sawLoading = true;
    const urlChanged = Boolean(previousUrl && tab.url && tab.url !== previousUrl);
    if (tab.status === 'complete' && (sawLoading || urlChanged || Date.now() - startedAt > 2000)) {
      return true;
    }
    await sleep(250);
  }
  // Same-page navigations (e.g. in-page routers) may never flip status.
  return true;
}

async function getSnapshot(tabId) {
  const response = await sendToTab(tabId, { type: 'fta:snapshot' });
  if (!response || response.ok !== true || !response.snapshot) {
    throw new Error(response?.error || 'The page could not be read.');
  }
  return response.snapshot;
}

async function executeActionOnTab(tabId, action) {
  let previousUrl = '';
  if (action.type === 'navigate' || action.type === 'back') {
    try {
      previousUrl = (await chrome.tabs.get(tabId))?.url || '';
    } catch {
      previousUrl = '';
    }
  }
  const response = await sendToTab(tabId, { type: 'fta:execute', action });
  if (action.type === 'navigate' || action.type === 'back') {
    await waitForTabSettled(tabId, previousUrl);
    await ensureInjected(tabId).catch(() => {});
  }
  return response || { ok: false, observation: 'The page did not respond.' };
}

/* ---------------------------------------------------------- task engine -- */

async function finishTask(outcome) {
  if (!currentTask) return;
  currentTask.status =
    outcome.status === 'done'
      ? TASK_STATUS.done
      : outcome.status === 'stopped'
        ? TASK_STATUS.stopped
        : TASK_STATUS.error;
  currentTask.answer =
    outcome.answer ||
    currentTask.answer ||
    (outcome.status === 'stopped' ? 'Stopped before the goal was reached.' : '');
  currentTask.error = outcome.error || null;
  currentTask.limitReached = Boolean(outcome.limitReached);
  currentTask.finishedAt = Date.now();
  currentTask.phase = currentTask.status;
  if (!currentTask.steps.length && Array.isArray(outcome.steps)) currentTask.steps = outcome.steps;

  abortController = null;
  const tabId = currentTask.tabId;

  if (tabId) {
    if (currentTask.status === TASK_STATUS.error) {
      sendHud(tabId, { running: false, tone: 'error', label: 'Fast Tab Agent · stopped with an error' });
    } else if (currentTask.status === TASK_STATUS.done) {
      sendHud(tabId, { running: false, tone: 'done', label: 'Fast Tab Agent · task complete' });
    } else {
      sendHud(tabId, { running: false, tone: 'done', label: 'Fast Tab Agent · stopped' });
    }
  }

  broadcast(currentTask);
  await persistTask();
}

async function startTask(goalInput) {
  if (currentTask && currentTask.status === TASK_STATUS.running) {
    throw new Error('A task is already running. Stop it first.');
  }
  // If this worker was restarted, recover an orphaned in-session task record
  // before a new run overwrites it. Tasks are not resumed automatically.
  await taskState();

  const goal = String(goalInput || '').trim().slice(0, LIMITS.maxTaskGoal);
  if (!goal) throw new Error('Describe what the agent should do on this page.');

  await ensureInit();
  const settings = await getSettings();
  hudEnabled = settings.showHud !== false;
  const provider = await store.getActive();
  if (!provider) {
    throw new ProviderError(ERROR_CODES.no_active_provider, 'Add and activate an AI provider first.');
  }
  const check = validateProviderForRequest(provider, { allowPrivateHttp: settings.allowPrivateHttp });
  if (!check.valid) {
    const [field, message] = Object.entries(check.errors)[0] || ['config', 'Finish configuring this provider.'];
    throw new ProviderError(ERROR_CODES.invalid_config, message, { field });
  }

  await requireProviderHostPermission(provider, settings.allowPrivateHttp);

  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found.');
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('Open a normal website (http or https) before running the agent.');
  }

  await ensureInjected(tab.id);

  currentTask = {
    id: `task_${Date.now().toString(36)}`,
    goal,
    status: TASK_STATUS.running,
    phase: 'starting',
    steps: [],
    startedAt: Date.now(),
    finishedAt: null,
    answer: '',
    error: null,
    maxSteps: settings.maxSteps,
    provider: { id: provider.id, name: provider.name, model: provider.model },
    tabId: tab.id,
    limitReached: false,
  };
  abortController = new AbortController();
  broadcast(currentTask);
  persistTask();
  sendHud(tab.id, { running: true, step: 0, maxSteps: settings.maxSteps });

  const taskId = currentTask.id;
  const controller = abortController;

  const callModel = async (messages) => {
    const result = await chatCompletion(provider, messages, {
      maxTokens: provider.maxTokens || settings.maxTokens,
      temperature: provider.temperature ?? settings.temperature,
      jsonMode: provider.useJsonMode || settings.jsonMode,
      allowPrivateHttp: settings.allowPrivateHttp,
      signal: controller.signal,
    });
    if (result.droppedParams?.length) {
      console.info('Fast Tab Agent: model rejected optional params, continued without', result.droppedParams);
    }
    return result;
  };

  const onEvent = (event) => {
    if (!currentTask || currentTask.id !== taskId || currentTask.status !== TASK_STATUS.running) return;
    switch (event.phase) {
      case 'start':
        currentTask.phase = 'thinking';
        break;
      case 'thinking':
        currentTask.phase = 'thinking';
        currentTask.currentStep = event.step;
        sendHud(tab.id, { running: true, step: event.step, maxSteps: settings.maxSteps });
        break;
      case 'step':
        pushStep(event.step);
        currentTask.phase = 'acting';
        sendHud(tab.id, { running: true, step: event.step.step, maxSteps: settings.maxSteps });
        break;
      case 'error':
        currentTask.error = event.error;
        break;
      default:
        break;
    }
    broadcast(currentTask);
    persistTask();
  };

  // Run detached: the popup gets progress through fta:progress messages.
  (async () => {
    try {
      const outcome = await runAgentTask({
        goal,
        maxSteps: settings.maxSteps,
        callModel,
        getSnapshot: () => getSnapshot(tab.id),
        executeAction: (action) => executeActionOnTab(tab.id, action),
        onEvent,
        signal: controller.signal,
      });
      if (!currentTask || currentTask.id !== taskId || currentTask.status !== TASK_STATUS.running) return;
      await finishTask(outcome);
    } catch (error) {
      if (!currentTask || currentTask.id !== taskId || currentTask.status !== TASK_STATUS.running) return;
      await finishTask({
        status: 'error',
        error: friendlyError(error),
        steps: currentTask.steps,
      });
    }
  })();

  return publicTask();
}

function stopTask() {
  if (!currentTask || currentTask.status !== TASK_STATUS.running) {
    return publicTask();
  }
  const taskId = currentTask.id;
  currentTask.phase = 'stopping';
  broadcast(currentTask);
  try {
    abortController?.abort();
  } catch {
    /* already aborted */
  }
  // Safety net: if something swallows the abort, settle the task anyway.
  setTimeout(() => {
    if (currentTask && currentTask.id === taskId && currentTask.status === TASK_STATUS.running) {
      finishTask({ status: 'stopped', steps: currentTask.steps, answer: 'Stopped by user.' });
    }
  }, 2500);
  return publicTask();
}

/* -------------------------------------------------------------- providers -- */

async function providersList() {
  await ensureInit();
  const { providers, activeId } = await store.list();
  return { providers: providers.map(providerForPopup), activeId };
}

const HARD_URL_CODES = new Set(['unsupported_scheme', 'credentials', 'link_local', 'malformed', 'query', 'too_long']);

async function providerSave(input) {
  await ensureInit();
  const normalized = normalizeProvider(input);
  if (!normalized) throw new ProviderError(ERROR_CODES.invalid_config, 'That provider configuration could not be read.');

  if (normalized.baseUrl) {
    const check = validateProvider(normalized, { allowPrivateHttp: true });
    if (!check.urlCheck.ok && HARD_URL_CODES.has(check.urlCheck.code)) {
      throw new ProviderError(ERROR_CODES.invalid_config, check.urlCheck.message, { field: 'baseUrl' });
    }
  }

  const before = await store.getById(normalized.id);
  if (!before) normalized.createdAt = normalized.createdAt || Date.now();
  const saved = await store.save(normalized);
  return {
    provider: providerForPopup(saved.provider),
    activeId: saved.activeId,
    created: !before,
    validation: (() => {
      const check = validateProvider(saved.provider, { allowPrivateHttp: true });
      return { valid: check.valid, errors: check.errors, warnings: check.warnings };
    })(),
  };
}

async function providerDelete(id) {
  await ensureInit();
  if (typeof id !== 'string' || !id) throw new Error('Missing provider id.');
  const result = await store.remove(id);
  if (currentTask && currentTask.provider?.id === id && currentTask.status === TASK_STATUS.running) {
    stopTask();
  }
  return result;
}

async function providerActivate(id) {
  await ensureInit();
  if (typeof id !== 'string' || !id) throw new Error('Missing provider id.');
  const result = await store.setActive(id);
  const provider = await store.getById(id);
  return { ...result, provider: provider ? providerForPopup(provider) : null };
}

async function resolveProvider(input) {
  await ensureInit();
  if (input && typeof input === 'object') {
    const normalized = normalizeProvider(input);
    if (!normalized) throw new ProviderError(ERROR_CODES.invalid_config, 'That configuration could not be read.');
    if (!normalized.apiKey) {
      const saved = await store.getById(normalized.id);
      if (saved?.apiKey) normalized.apiKey = saved.apiKey;
    }
    return normalized;
  }
  if (typeof input === 'string') {
    const saved = await store.getById(input);
    if (!saved) throw new ProviderError(ERROR_CODES.invalid_config, 'That provider no longer exists.');
    return saved;
  }
  const active = await store.getActive();
  if (!active) throw new ProviderError(ERROR_CODES.no_active_provider, 'No provider is configured.');
  return active;
}

async function providerTest(message) {
  const provider = await resolveProvider(message.provider ?? message.id ?? null);
  const settings = await getSettings();
  await requireProviderHostPermission(provider, settings.allowPrivateHttp);
  const result = await testConnection(provider, {
    fetchImpl: fetch,
    allowPrivateHttp: settings.allowPrivateHttp,
  });
  // Belt and braces: nothing here can contain the key, but strip it anyway.
  const safe = { ...result };
  delete safe.apiKey;
  return { ...safe, model: safe.model || provider.model, provider: publicProvider(provider) };
}

async function providerModels(message) {
  const provider = await resolveProvider(message.provider ?? message.id ?? null);
  const settings = await getSettings();
  await requireProviderHostPermission(provider, settings.allowPrivateHttp);
  return listModels(provider, { fetchImpl: fetch, allowPrivateHttp: settings.allowPrivateHttp });
}

/* ---------------------------------------------------------------- router -- */

async function appInfo() {
  const tab = await getActiveTab();
  const settings = await getSettings();
  return {
    version: chrome.runtime.getManifest().version,
    settings,
    tab: tab
      ? {
          id: tab.id,
          title: tab.title || '',
          url: tab.url || '',
          supported: Boolean(tab.url && /^https?:/i.test(tab.url)),
        }
      : null,
    task: publicTask(),
  };
}

async function taskState() {
  if (currentTask) return publicTask();
  try {
    const bag = await chrome.storage.session.get(TASK_STORAGE_KEY);
    const stored = bag?.[TASK_STORAGE_KEY] || null;
    if (stored && stored.status === TASK_STATUS.running) {
      // A running task cannot outlive the worker that owns it, so this is the
      // leftover of an interrupted run (browser restart, crashed worker).
      const settled = {
        ...stored,
        status: TASK_STATUS.stopped,
        phase: 'stopped',
        finishedAt: Date.now(),
        answer: stored.answer || 'The background worker restarted, so this run was interrupted.',
        error: { code: 'interrupted', message: 'The background worker restarted during this task.' },
      };
      await chrome.storage.session.set({ [TASK_STORAGE_KEY]: settled });
      return settled;
    }
    return stored;
  } catch {
    return null;
  }
}

const handlers = {
  'providers:list': () => providersList(),
  'providers:save': (message) => providerSave(message.provider),
  'providers:delete': (message) => providerDelete(message.id),
  'providers:activate': (message) => providerActivate(message.id),
  'providers:test': (message) => providerTest(message),
  'providers:models': (message) => providerModels(message),
  'settings:get': async () => ({ settings: await getSettings() }),
  'settings:save': (message) => saveSettings(message.settings || message.patch || {}).then((settings) => ({ settings })),
  'task:start': (message) => startTask(message.goal),
  'task:stop': async () => ({ task: stopTask() }),
  'task:state': () => taskState(),
  'app:info': () => appInfo(),
};

function isPopupSender(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  const popupUrl = chrome.runtime.getURL('src/popup/popup.html');
  return sender.url === popupUrl;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  // Provider records (and especially keys) are returned only to the popup.
  // The injected page agent may request task cancellation for its own tab, but
  // it cannot call provider/settings/task-start APIs.
  const hudStop = message.type === 'task:stop' && message.source === 'hud' &&
    sender?.id === chrome.runtime.id && sender?.tab?.id === currentTask?.tabId;
  if (!isPopupSender(sender) && !hudStop) return false;
  const handler = handlers[message.type];
  if (!handler) return false;

  Promise.resolve()
    .then(() => handler(message))
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((error) => {
      const friendly = friendlyError(error);
      const field = error?.field || null;
      sendResponse({ ok: false, error: { ...friendly, field } });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureInit()
    .then(async () => {
      const settings = await chrome.storage.local.get(STORAGE_KEYS.settings);
      if (!settings?.[STORAGE_KEYS.settings]) {
        await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS } });
      }
    })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void ensureInit().catch(() => {});
});

// Warm the store as soon as the worker starts so the first popup render is fast.
void ensureInit().catch(() => {});
