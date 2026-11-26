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
import {
  DEFAULT_SETTINGS,
  LIMITS,
  STORAGE_KEYS,
  TAB_LIST_LIMIT,
  TASK_STORAGE_KEY,
  TASK_STATUS,
} from './lib/constants.js';
import { ERROR_CODES, ProviderError, friendlyError } from './lib/errors.js';
import { runAgentTask } from './lib/agent-runner.js';
import {
  chooseInitialTabId,
  classifyInjectionError,
  classifyTabUrl,
  originPatternFor,
  tabHost,
  tabTitleFor,
} from './lib/tabs.js';

// The toolbar button opens Chrome's side panel rather than a popup. A popup is
// destroyed as soon as the user clicks the page, which makes it impossible to
// watch a task while interacting with the tab it is working on.
const sidePanel = chrome.sidePanel;
if (sidePanel?.setPanelBehavior) {
  sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (!sidePanel?.open || !tab?.windowId) return;
    sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  });
}

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
  if (['auto', 'light', 'dark'].includes(source.theme)) settings.theme = source.theme;
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
/** Guard against two `task:start` messages racing before currentTask exists. */
let startingTask = false;

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
    tabTitle: task.tabTitle || '',
    tabHost: task.tabHost || '',
    currentStep: task.currentStep || 0,
    currentAction: task.currentAction || null,
    currentActionLabel: task.currentActionLabel || '',
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
  } catch (error) {
    const raw = String(error?.message || '');
    if (raw) console.warn('Fast Tab Agent: page agent injection failed:', raw);
    const failure = classifyInjectionError(raw);
    throw new ProviderError(failure.code, failure.message, { hint: failure.hint });
  }
  const ready = await pingTab(tabId);
  if (!ready) {
    throw new ProviderError(
      ERROR_CODES.tab_unavailable,
      'The page agent did not start on this tab.',
      { hint: 'Reload the tab and try again. Some pages replace their content during loading.' },
    );
  }
  return true;
}

/** Narrow, secret-free metadata for the current task. */
function taskTabMetadata(tab) {
  const url = tab?.url || tab?.pendingUrl || '';
  return {
    title: tabTitleFor(tab),
    host: tabHost(url),
  };
}

/**
 * Resolve the tab a task should run on.
 *
 * The popup passes the tab the user explicitly selected. Missing host access
 * is rejected here even when the popup says it granted it, so the worker never
 * assumes access it does not have.
 */
async function resolveTargetTab(requestedTabId) {
  let tab = null;
  if (requestedTabId !== undefined && requestedTabId !== null && requestedTabId !== '') {
    const id = Number(requestedTabId);
    if (!Number.isInteger(id) || id < 0) {
      throw new ProviderError(ERROR_CODES.tab_unavailable, 'That tab could not be identified.');
    }
    try {
      tab = await chrome.tabs.get(id);
    } catch {
      throw new ProviderError(
        ERROR_CODES.tab_unavailable,
        'That tab was closed before the task started.',
      );
    }
  } else {
    tab = await getActiveTab();
    if (!tab || typeof tab.id !== 'number') throw new Error('No active tab found.');
  }

  const url = tab.url || tab.pendingUrl || '';
  const check = classifyTabUrl(url);
  if (!check.supported) {
    throw new ProviderError(
      check.code === 'no_url' ? ERROR_CODES.tab_unavailable : ERROR_CODES.tab_restricted,
      check.reason,
      { hint: 'Choose a normal http(s) page in the tab picker.' },
    );
  }

  // Never assume the active tab is reachable. Chrome's temporary `activeTab`
  // grant cannot be queried, is lost when the page navigates, and does not
  // follow a tab switch — which is how “Page access” used to be reported for a
  // tab that could not actually be injected. Check the real host permission.
  const origin = originPatternFor(url);
  const granted =
    origin && chrome.permissions?.contains
      ? await chrome.permissions.contains({ origins: [origin] }).catch(() => false)
      : false;
  if (!granted) {
    throw new ProviderError(
      ERROR_CODES.tab_permission_required,
      `Fast Tab Agent needs your permission to work on ${tabHost(url) || 'that website'}.`,
      { hint: 'Click the tab’s access badge (or choose it in the tab picker), allow access, then send the request again.' },
    );
  }
  return tab;
}

/**
 * List open tabs with only the metadata the picker needs. Page content is not
 * read here; it is read later, for the one tab the user selects.
 */
async function tabsList() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    throw new Error('Chrome could not list the open tabs. Try again.');
  }

  const active = await getActiveTab();
  const hasPermissionCheck = typeof chrome.permissions?.contains === 'function';
  let hasTabsPermission = false;
  if (hasPermissionCheck) {
    try {
      hasTabsPermission = (await chrome.permissions.contains({ permissions: ['tabs'] })) === true;
    } catch {
      hasTabsPermission = false;
    }
  }

  const originCache = new Map();
  const list = [];
  for (const tab of tabs.slice(0, TAB_LIST_LIMIT)) {
    if (typeof tab?.id !== 'number') continue;
    const rawUrl = typeof tab.url === 'string' ? tab.url : typeof tab.pendingUrl === 'string' ? tab.pendingUrl : '';
    // Without the optional `tabs` permission Chrome hides title and URL for
    // other tabs. That is “unknown”, not “restricted”: the picker can request
    // tab-list access and then classify the real URL.
    const check = rawUrl
      ? classifyTabUrl(rawUrl)
      : { supported: true, code: 'unknown', reason: '' };
    let permission = 'unknown';
    if (rawUrl) {
      if (!check.supported) permission = 'unavailable';
      else if (hasPermissionCheck) {
        // `activeTab` cannot be queried and lasts only until the page
        // navigates, so every tab — including the active one — reports the
        // real host grant. Reporting a temporary grant as permanent access is
        // what let the agent start on a tab it could not read.
        const origin = originPatternFor(rawUrl);
        if (origin) {
          if (!originCache.has(origin)) {
            originCache.set(
              origin,
              await chrome.permissions.contains({ origins: [origin] }).catch(() => false),
            );
          }
          permission = originCache.get(origin) ? 'granted' : 'needed';
        }
      }
    }

    const favicon =
      typeof tab.favIconUrl === 'string' &&
      tab.favIconUrl.length <= 2048 &&
      /^(https:|data:image\/)/i.test(tab.favIconUrl)
        ? tab.favIconUrl
        : '';

    list.push({
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: tab.title || '',
      url: rawUrl,
      favIconUrl: favicon,
      active: tab.id === active?.id,
      pinned: tab.pinned === true,
      supported: check.supported,
      restricted: !check.supported,
      reason: check.reason,
      permission,
    });
  }

  return {
    tabs: list,
    // The popup uses activeTabId as its initial selection. If the real active
    // tab is a chrome:// page the agent can never read, offer the first usable
    // website tab instead of pointing the composer at a dead end.
    activeTabId: chooseInitialTabId(list, active?.id ?? null),
    total: tabs.length,
    truncated: tabs.length > list.length,
    hasTabsPermission,
    canRequestTabs: hasPermissionCheck,
  };
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
  currentTask.currentAction = null;
  currentTask.currentActionLabel = '';
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

async function startTask(goalInput, requestedTabId) {
  if (startingTask) throw new Error('A task is already starting. Wait a moment.');
  if (currentTask && currentTask.status === TASK_STATUS.running) {
    throw new Error('A task is already running. Stop it first.');
  }

  startingTask = true;
  let goal;
  let settings;
  let provider;
  let tab;
  try {
    // If this worker was restarted, recover an orphaned in-session task record
    // before a new run overwrites it. Tasks are not resumed automatically.
    await taskState();

    goal = String(goalInput || '').trim().slice(0, LIMITS.maxTaskGoal);
    if (!goal) throw new Error('Describe what the agent should do on this page.');

    await ensureInit();
    settings = await getSettings();
    hudEnabled = settings.showHud !== false;
    provider = await store.getActive();
    if (!provider) {
      throw new ProviderError(ERROR_CODES.no_active_provider, 'Add and activate an AI provider first.');
    }
    const check = validateProviderForRequest(provider, { allowPrivateHttp: settings.allowPrivateHttp });
    if (!check.valid) {
      const [field, message] = Object.entries(check.errors)[0] || ['config', 'Finish configuring this provider.'];
      throw new ProviderError(ERROR_CODES.invalid_config, message, { field });
    }

    await requireProviderHostPermission(provider, settings.allowPrivateHttp);
    tab = await resolveTargetTab(requestedTabId);
    // Bring the chosen tab to the front so the user can watch the agent work
    // and so background-tab throttling cannot stall clicks, typing or focus.
    try {
      const active = await getActiveTab();
      if (active?.id !== tab.id) await chrome.tabs.update?.(tab.id, { active: true });
    } catch {
      /* the task can still run in a background tab */
    }
    await ensureInjected(tab.id);

    const metadata = taskTabMetadata(tab);
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
      tabTitle: metadata.title,
      tabHost: metadata.host,
      limitReached: false,
      currentStep: 0,
      currentAction: null,
      currentActionLabel: '',
    };
  } finally {
    startingTask = false;
  }
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
        currentTask.phase = 'starting';
        break;
      case 'reading':
        currentTask.phase = 'reading';
        currentTask.currentStep = event.step || currentTask.currentStep;
        break;
      case 'thinking':
        currentTask.phase = 'thinking';
        currentTask.currentStep = event.step;
        currentTask.currentAction = null;
        currentTask.currentActionLabel = '';
        sendHud(tab.id, { running: true, step: event.step, maxSteps: settings.maxSteps });
        break;
      case 'action':
        currentTask.phase = 'acting';
        currentTask.currentAction = event.action || null;
        currentTask.currentActionLabel = event.description || '';
        break;
      case 'step':
        pushStep(event.step);
        currentTask.phase = 'acting';
        currentTask.currentAction = null;
        currentTask.currentActionLabel = '';
        sendHud(tab.id, { running: true, step: event.step.step, maxSteps: settings.maxSteps });
        break;
      case 'finishing':
        currentTask.phase = 'finishing';
        currentTask.currentAction = null;
        currentTask.currentActionLabel = '';
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
  const rawUrl = tab?.url || tab?.pendingUrl || '';
  const check = classifyTabUrl(rawUrl);
  const origin = check.supported ? originPatternFor(rawUrl) : null;
  const granted =
    origin && chrome.permissions?.contains
      ? await chrome.permissions.contains({ origins: [origin] }).catch(() => false)
      : false;
  return {
    version: chrome.runtime.getManifest().version,
    settings,
    tab: tab
      ? {
          id: tab.id,
          title: tabTitleFor(tab),
          url: rawUrl,
          host: tabHost(rawUrl),
          supported: check.supported,
          restricted: !check.supported,
          reason: check.reason,
          permission: check.supported ? (granted ? 'granted' : 'needed') : 'unavailable',
          active: true,
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
  'task:start': (message) => startTask(message.goal, message.tabId),
  'task:stop': async () => ({ task: stopTask() }),
  'task:state': () => taskState(),
  'tabs:list': () => tabsList(),
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
