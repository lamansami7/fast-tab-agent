/**
 * Fast Tab Agent — popup controller.
 *
 * The popup is presentation + orchestration only:
 *  - provider records, endpoint permission checks and all network traffic live
 *    in the background service worker;
 *  - page content is read by the page agent only for the tab the user selects;
 *  - this file owns the conversation, tab picker and settings surfaces.
 *
 * API keys never enter a web page. They are read into the provider editor (an
 * extension page) and stored by the background worker in trusted local storage.
 */

import { PRESETS, getPreset, isKnownPresetHost } from '../lib/presets.js';
import {
  createProvider,
  validateProvider,
  validateProviderForRequest,
  resolveEndpoint,
  maskApiKey,
} from '../lib/providers.js';
import { DEFAULT_SETTINGS } from '../lib/constants.js';
import { displayHost } from '../lib/urls.js';
import {
  classifyTabUrl,
  filterTabs,
  originPatternFor,
  sortTabsForPicker,
  tabHost,
  tabTitleFor,
} from '../lib/tabs.js';
import {
  createChatMessage,
  createChatStore,
  taskToMessagePatch,
  trimChatMessages,
} from '../lib/chat.js';

const $ = (selector, root = document) => root.querySelector(selector);

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g']);

const el = (tag, props = {}, ...children) => {
  // `document.createElement('svg')` creates an HTML element, which renders as
  // nothing. Icons built by the UI must live in the SVG namespace.
  const node = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
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
  settingsPanel: 'ai',
  providers: [],
  activeId: null,
  permissionOrigins: new Set(),
  settings: { ...DEFAULT_SETTINGS },
  appVersion: '',
  tabs: [],
  tabsMeta: { total: 0, truncated: false, hasTabsPermission: false, canRequestTabs: true },
  activeTabId: null,
  selectedTabId: null,
  tabFilter: '',
  chat: [],
  chatStore: createChatStore(globalThis.chrome?.storage?.local || null),
  activeAssistantId: null,
  openSteps: new Set(),
  chatSaveTimer: null,
  task: null,
  busyStarting: false,
  // provider editor
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
  // conversation clearing
  clearPending: false,
  toastTimer: null,
};

const VIEWS = {
  main: $('#viewMain'),
  settings: $('#viewSettings'),
  new: $('#viewNew'),
  editor: $('#viewEditor'),
  tabs: $('#viewTabs'),
};

const FOCUS_ON_SHOW = {
  settings: '#settingsBack',
  new: '#customProviderBtn',
  editor: '#fName',
  tabs: '#tabSearch',
  main: '#goalInput',
};

/* --------------------------------------------------------------- messaging */

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
          const provider =
            payload.provider ||
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

function toast(message, tone = 'info') {
  const node = $('#toast');
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

/* ------------------------------------------------------------------ theme */

function applyTheme() {
  const theme = ['auto', 'light', 'dark'].includes(state.settings.theme) ? state.settings.theme : 'auto';
  document.documentElement.dataset.theme = theme;
}

/* ------------------------------------------------------------------ views */

function showView(name) {
  if (!VIEWS[name]) return;
  state.view = name;
  for (const [key, node] of Object.entries(VIEWS)) node.hidden = key !== name;

  // Keep the covered UI out of the tab order while an overlay is open.
  const overlayOpen = name !== 'main';
  const topbar = $('.topbar');
  if (topbar) topbar.inert = overlayOpen;
  VIEWS.main.inert = overlayOpen;

  const selector = FOCUS_ON_SHOW[name];
  if (selector) setTimeout(() => $(selector)?.focus({ preventScroll: true }), 30);
}

function setSettingsPanel(panel) {
  state.settingsPanel = panel === 'behavior' ? 'behavior' : 'ai';
  const ai = state.settingsPanel === 'ai';
  $('#tabAi').setAttribute('aria-selected', String(ai));
  $('#tabBehavior').setAttribute('aria-selected', String(!ai));
  $('#panelProviders').hidden = !ai;
  $('#panelBehavior').hidden = ai;
  if (!ai) void renderSiteAccess();
}

function openSettings(panel = state.settingsPanel) {
  setSettingsPanel(panel);
  renderProviderList();
  renderPreferences();
  renderChatMeta();
  showView('settings');
  void renderSiteAccess();
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
  return preset?.accent || '#7c6cf5';
}

function hostOf(provider) {
  if (!provider?.baseUrl) return 'No endpoint';
  return displayHost(provider.baseUrl).slice(0, 60);
}

function activeProvider() {
  return state.providers.find((provider) => provider.id === state.activeId) || null;
}

function selectedTab() {
  return (
    state.tabs.find((tab) => tab.id === state.selectedTabId) ||
    state.tabs.find((tab) => tab.id === state.activeTabId) ||
    state.tabs[0] ||
    null
  );
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

function timeOf(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function setFavicon(node, tab) {
  node.replaceChildren();
  const title = tabTitleFor(tab);
  const fallback = (title.trim()[0] || 'F').toUpperCase();
  const src = tab?.favIconUrl;
  if (typeof src === 'string' && /^(https:|data:image\/)/i.test(src)) {
    const img = el('img', { src, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
    img.addEventListener('error', () => node.replaceChildren(document.createTextNode(fallback)));
    node.append(img);
  } else {
    node.append(document.createTextNode(fallback));
  }
}

/* -------------------------------------------------------------- status UI */

const ACTION_ACTIVITY = {
  click: 'Clicking an element…',
  type: 'Typing into a field…',
  select: 'Choosing an option…',
  key: 'Pressing a key…',
  scroll: 'Scrolling the page…',
  navigate: 'Opening a page…',
  back: 'Going back…',
  wait: 'Waiting for the page…',
  extract: 'Reading page content…',
};

const PHASE_ACTIVITY = {
  starting: 'Getting ready…',
  reading: 'Reading the page…',
  thinking: 'Planning the next step…',
  acting: 'Working on the page…',
  finishing: 'Writing the answer…',
  stopping: 'Stopping…',
  done: 'Finished',
  stopped: 'Stopped',
  error: 'Failed',
};

function activityForTask(task) {
  if (!task) return '';
  if (task.phase === 'stopping') return 'Stopping…';
  if (task.phase === 'acting' && (task.currentAction?.type || task.currentActionLabel)) {
    return ACTION_ACTIVITY[task.currentAction?.type] || task.currentActionLabel;
  }
  return PHASE_ACTIVITY[task.phase] || 'Working…';
}

function renderChip() {
  const provider = activeProvider();
  const label = $('#chipLabel');
  const dot = $('#chipDot');
  const chip = $('#providerChip');

  if (!provider) {
    label.textContent = 'Add provider';
    dot.dataset.state = 'incomplete';
    chip.title = 'Add an AI provider';
  } else {
    label.textContent = provider.name;
    dot.dataset.state = isRunnable(provider) ? 'ready' : 'incomplete';
    chip.title = `${provider.name} · ${provider.model || 'no model'} — manage providers`;
  }
}

function hintForState() {
  if (state.busyStarting) return { message: 'Starting…', tone: '' };
  if (state.task?.status === 'running') return { message: '', tone: '' };

  const provider = activeProvider();
  if (!provider) {
    return { message: 'Add an AI provider to start — any OpenAI-compatible endpoint works.', tone: 'warn' };
  }
  if (!provider.model) return { message: `Set a model id for ${provider.name}.`, tone: 'warn' };
  if (!isRunnable(provider)) {
    const check = validateProvider(provider, { allowPrivateHttp: state.settings.allowPrivateHttp });
    const firstError = Object.values(check.errors)[0];
    return { message: firstError || 'This provider needs attention.', tone: 'error' };
  }

  const tab = selectedTab();
  if (!tab) return { message: 'Open a website tab to begin.', tone: 'warn' };
  if (tab.restricted) return { message: tab.reason || 'This page cannot be read.', tone: 'error' };
  if (tab.permission === 'needed') {
    return { message: 'This tab needs website access — sending will ask Chrome.', tone: 'warn' };
  }
  if (tab.permission === 'unknown') {
    return { message: 'Sending will ask Chrome for access to this tab.', tone: 'warn' };
  }
  return { message: '', tone: '' };
}

function renderStatus() {
  renderChip();

  const brand = $('#brandStatus');
  if (state.task?.status === 'running') brand.textContent = 'Working on a tab';
  else if (!activeProvider()) brand.textContent = 'Add a provider';
  else if (!isRunnable(activeProvider())) brand.textContent = 'Provider needs attention';
  else brand.textContent = 'Ready';

  const hint = hintForState();
  const hintNode = $('#goalHint');
  hintNode.textContent = hint.message;
  if (hint.tone) hintNode.dataset.tone = hint.tone;
  else delete hintNode.dataset.tone;

  const task = state.task;
  const running = task?.status === 'running';
  $('#runBoard').hidden = !running;
  if (running) {
    const stage = activityForTask(task);
    if ($('#runStage').textContent !== stage) $('#runStage').textContent = stage;
    $('#runBudget').textContent = `${task.steps?.filter((step) => !step.done).length || 0} / ${task.maxSteps || 1} steps used`;
    $('#runMeter').max = task.maxSteps || 1;
    $('#runMeter').value = task.steps?.length || 0;
    const plan = task.plan || [];
    $('#runPlanBox').hidden = !plan.length;
    const key = JSON.stringify(plan);
    if ($('#runPlan').dataset.key !== key) {
      $('#runPlan').dataset.key = key;
      $('#runPlan').replaceChildren(...plan.map((text) => el('li', { text })));
    }
  }
  renderComposer();
}

function renderComposer() {
  const running = state.task?.status === 'running';
  const runBtn = $('#runBtn');
  const stopBtn = $('#stopBtn');
  $('#taskMode').disabled = running || state.busyStarting;
  runBtn.hidden = running;
  stopBtn.hidden = !running;
  runBtn.disabled = state.busyStarting || !$('#goalInput').value.trim();
  stopBtn.disabled = false;
}

/* ------------------------------------------------------------ tab context */

function renderTabBar() {
  const tab = selectedTab();
  const titleNode = $('#tabTitle');
  const hostNode = $('#tabHost');
  const permNode = $('#tabPermBtn');
  const countNode = $('#tabCount');
  const favNode = $('#tabFavicon');

  if (!tab) {
    titleNode.textContent = 'No tab selected';
    hostNode.textContent = '—';
    favNode.replaceChildren(document.createTextNode('F'));
    permNode.textContent = 'No page';
    permNode.dataset.state = 'unknown';
    permNode.title = 'Open a website tab to use the agent.';
    countNode.hidden = true;
    return;
  }

  titleNode.textContent = tabTitleFor(tab);
  titleNode.title = tabTitleFor(tab);
  hostNode.textContent = tabHost(tab.url) || 'Address hidden';
  setFavicon(favNode, tab);

  const restricted = tab.restricted || !tab.supported;
  if (restricted) {
    permNode.textContent = 'Restricted';
    permNode.dataset.state = 'restricted';
    permNode.title = tab.reason || 'Chrome blocks extensions on this page.';
  } else if (tab.permission === 'granted') {
    permNode.textContent = 'Page access';
    permNode.dataset.state = 'granted';
    permNode.title = 'Website access is granted for this tab.';
  } else if (tab.permission === 'needed') {
    permNode.textContent = 'Allow access';
    permNode.dataset.state = 'needed';
    permNode.title = 'Fast Tab Agent needs your permission to read this tab.';
  } else {
    permNode.textContent = 'Access unknown';
    permNode.dataset.state = 'unknown';
    permNode.title = 'Chrome has not shared this tab’s address yet. Select it in the tab picker.';
  }

  const total = state.tabsMeta.total || state.tabs.length;
  countNode.textContent = String(total);
  countNode.hidden = total <= 0;
}

/* ------------------------------------------------------------------- chat */

function persistChatNow() {
  clearTimeout(state.chatSaveTimer);
  void state.chatStore.save(state.chat);
}

function scheduleChatSave() {
  clearTimeout(state.chatSaveTimer);
  state.chatSaveTimer = setTimeout(() => {
    void state.chatStore.save(state.chat);
  }, 350);
}

/**
 * Render a very small, safe subset of model formatting: **bold** and `code`.
 * Everything else stays literal text — no HTML, links, images or Markdown
 * parsing beyond these two inline spans.
 */
function appendRichText(node, text) {
  const source = typeof text === 'string' ? text : '';
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match.index > cursor) node.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('**')) {
      node.append(el('strong', { text: token.slice(2, -2) }));
    } else {
      node.append(el('code', { text: token.slice(1, -1) }));
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) node.append(document.createTextNode(source.slice(cursor)));
}

/** Turn the action log's technical descriptions into readable labels. */
function friendlyStepDescription(description) {
  const text = typeof description === 'string' ? description.trim() : '';
  if (!text) return 'Action';
  if (text === 'finish' || text === 'done') return 'Finished';
  if (text.startsWith('click ')) return 'Clicked an element';
  if (text.startsWith('type ')) return 'Typed into a field';
  if (text.startsWith('select ')) return 'Chose an option';
  if (text.startsWith('scroll ')) return 'Scrolled the page';
  if (text.startsWith('navigate ')) return 'Opened a page';
  if (text === 'browser back') return 'Went back';
  if (text.startsWith('wait ')) return 'Waited for the page';
  if (text.startsWith('extract ')) return 'Read page content';
  if (text.startsWith('press ')) return 'Pressed a key';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function statusLabel(message) {
  if (message.status === 'running') return message.phase === 'stopping' ? 'Stopping' : 'Working';
  if (message.status === 'stopped') return 'Stopped';
  if (message.status === 'error') return 'Failed';
  if (message.status === 'done') return message.limitReached ? 'Step limit' : 'Done';
  return 'Done';
}

function activityLabel(message) {
  if (message.status === 'running' && message.liveActivity) return message.liveActivity;
  return PHASE_ACTIVITY[message.phase] || 'Working…';
}

function renderSteps(message) {
  const details = el('details', { class: 'steps-wrap' });
  const steps = Array.isArray(message.steps) ? message.steps : [];
  details.append(
    el('summary', {
      text:
        message.status === 'running'
          ? `Activity (${steps.length})`
          : `${steps.length} action${steps.length === 1 ? '' : 's'}`,
    }),
  );
  const list = el('ol', { class: 'steps' });
  for (const step of steps.slice(-10)) {
    const item = el('li', { class: 'step', dataset: { ok: String(step.ok !== false) } });
    item.append(el('span', { class: 'step-icon', 'aria-hidden': 'true', text: step.ok === false ? '!' : '✓' }));
    const text = el('span', { class: 'step-text' });
    text.append(
      el('span', {
        class: 'step-desc',
        text: `${step.step}. ${friendlyStepDescription(step.description)}`,
      }),
    );
    if (step.observation) text.append(el('span', { class: 'step-obs', text: step.observation }));
    item.append(text);
    list.append(item);
  }
  details.append(list);
  details.open = message.status === 'running' || state.openSteps.has(message.id);
  details.addEventListener('toggle', () => {
    if (details.open) state.openSteps.add(message.id);
    else state.openSteps.delete(message.id);
  });
  return details;
}

function renderMessage(message) {
  if (message.role === 'user') {
    const reuse = el('button', { class: 'message-tool', type: 'button', text: 'Reuse request' });
    reuse.addEventListener('click', () => {
      const input = $('#goalInput');
      if (input.value && !window.confirm('Replace the current draft?')) return;
      input.value = message.text;
      autosizeInput();
      renderComposer();
      input.focus();
    });
    return el('article', { class: 'msg msg-user' }, el('div', { class: 'msg-bubble', text: message.text }), reuse);
  }

  const status = message.status || 'done';
  const article = el('article', { class: 'msg msg-assistant', dataset: { state: status } });

  const avatar = el('span', { class: 'msg-avatar', 'aria-hidden': 'true' });
  avatar.append(
    el(
      'svg',
      { viewBox: '0 0 24 24', width: '12', height: '12', fill: 'none', 'aria-hidden': 'true' },
      el('path', { d: 'M13.4 2.5 5 13.2h5.1l-1.5 8.3 8.6-11H12l1.4-8Z', fill: 'currentColor' }),
    ),
  );

  const body = el('div', { class: 'msg-body' });
  const meta = el('div', { class: 'msg-meta' });
  meta.append(
    el('span', { class: 'msg-author', text: 'Fast Tab Agent' }),
    el('span', { class: 'status-chip', dataset: { state: status }, text: statusLabel(message) }),
    el('time', { class: 'msg-time', text: timeOf(message.at) }),
  );
  body.append(meta);

  if (message.text) {
    const textNode = el('div', { class: 'msg-text' });
    appendRichText(textNode, message.text);
    body.append(textNode);
  }

  if (status === 'running') {
    body.append(
      el(
        'div',
        { class: 'activity', role: 'status', 'aria-live': 'polite' },
        el('span', { class: 'pulse', 'aria-hidden': 'true' }),
        el('span', { text: activityLabel(message) }),
      ),
    );
  }

  if (Array.isArray(message.steps) && message.steps.length) {
    body.append(renderSteps(message));
  }

  if (message.error?.message) {
    const errorNode = el('div', { class: 'msg-error', role: 'alert' });
    errorNode.append(el('strong', { text: message.error.message }));
    if (message.error.hint) errorNode.append(el('span', { text: message.error.hint }));
    body.append(errorNode);
  }

  if (message.tabTitle) body.append(el('div', { class: 'msg-tab', text: `Tab: ${message.tabTitle}` }));

  if (message.text && status !== 'running') {
    const copy = el('button', { class: 'message-tool', type: 'button', text: 'Copy answer' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message.text);
        toast('Answer copied.', 'success');
      } catch {
        toast('Could not copy automatically. Select the answer to copy it.', 'error');
      }
    });
    body.append(copy);
  }
  article.append(avatar, body);
  return article;
}

const messageNodes = new Map();

function renderMessages() {
  const log = $('#chatLog');
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 90;
  const messages = $('#messages');
  const liveIds = new Set(state.chat.map((message) => message.id));
  for (const [id, entry] of messageNodes) {
    if (!liveIds.has(id)) {
      entry.node.remove();
      messageNodes.delete(id);
    }
  }
  let cursor = messages.firstChild;
  for (const message of state.chat) {
    const key = JSON.stringify(message);
    let entry = messageNodes.get(message.id);
    if (entry?.key !== key) {
      const node = renderMessage(message);
      if (entry?.node === cursor) cursor = cursor.nextSibling;
      entry?.node.remove();
      entry = { key, node };
      messageNodes.set(message.id, entry);
    }
    if (entry.node !== cursor) messages.insertBefore(entry.node, cursor);
    cursor = entry.node.nextSibling;
  }

  $('#emptyState').hidden = state.chat.length > 0;

  if (nearBottom || state.chat.length <= 2) {
    requestAnimationFrame(() => {
      log.scrollTop = log.scrollHeight;
    });
  }
}

function renderChatMeta() {
  const count = state.chat.length;
  $('#chatCount').textContent = count ? `${count} message${count === 1 ? '' : 's'}` : 'No messages';
  $('#clearChatBtn').disabled = count === 0;
  if (!count) {
    state.clearPending = false;
    $('#clearConfirm').hidden = true;
  }
}

/* -------------------------------------------------------------- task flow */

function applyTask(task, { createIfMissing = false } = {}) {
  if (!task || typeof task !== 'object') return;

  state.task = task;
  if (task.status === 'running' && task.tabId != null && state.tabs.some((tab) => tab.id === task.tabId)) {
    state.selectedTabId = task.tabId;
  }

  const patch = taskToMessagePatch(task);
  let message = task.id
    ? state.chat.find((item) => item.role === 'assistant' && item.taskId === task.id)
    : null;
  if (!message && state.activeAssistantId) {
    const candidate = state.chat.find((item) => item.id === state.activeAssistantId);
    if (candidate && candidate.status === 'running' && (!candidate.taskId || candidate.taskId === task.id)) {
      message = candidate;
    }
  }
  if (!message && createIfMissing) {
    message = createChatMessage({
      role: 'assistant',
      status: 'running',
      taskId: task.id,
      tabTitle: task.tabTitle,
      phase: task.phase,
    });
    state.chat = trimChatMessages([...state.chat, message]);
  }

  if (message) {
    Object.assign(message, patch);
    if (task.id) message.taskId = task.id;
    if (task.tabTitle) message.tabTitle = task.tabTitle;
    message.liveActivity = task.status === 'running' ? activityForTask(task) : '';
    state.activeAssistantId = message.id;
  }

  if (task.status !== 'running') {
    state.busyStarting = false;
    persistChatNow();
  } else {
    scheduleChatSave();
  }

  renderStatus();
  renderMessages();
  renderTabBar();
}

async function startTask() {
  if (state.busyStarting || state.task?.status === 'running') return;

  const input = $('#goalInput');
  const goal = input.value.trim();
  const mode = $('#taskMode').value;
  if (!goal) {
    input.focus();
    return;
  }

  const provider = activeProvider();
  if (!provider) {
    openSettings('ai');
    toast('Add and activate a provider first.', 'error');
    return;
  }
  const tab = selectedTab();
  if (!tab) {
    toast('Open a website tab first.', 'error');
    return;
  }
  if (tab.restricted || !tab.supported) {
    toast(tab.reason || 'Chrome blocks extensions on this page.', 'error');
    return;
  }

  state.busyStarting = true;
  renderStatus();

  try {
    // Both permission prompts happen before the conversation is updated, so a
    // denied prompt leaves the user's text ready to retry.
    if (!(await ensureTabAccess(tab))) return;
    await ensureEndpointPermission(provider);
  } catch (error) {
    toast(error.message || 'Permission is required before the agent can run.', 'error');
    return;
  } finally {
    if (!state.task || state.task.status !== 'running') state.busyStarting = false;
    renderStatus();
  }

  const fresh = state.tabs.find((item) => item.id === tab.id) || tab;
  if (fresh.restricted || !fresh.supported) {
    toast(fresh.reason || 'Chrome blocks extensions on this page.', 'error');
    return;
  }

  const userMessage = createChatMessage({ role: 'user', text: goal });
  const assistantMessage = createChatMessage({
    role: 'assistant',
    status: 'running',
    phase: 'starting',
    tabTitle: tabTitleFor(fresh),
  });
  state.chat = trimChatMessages([...state.chat, userMessage, assistantMessage]);
  state.activeAssistantId = assistantMessage.id;
  input.value = '';
  autosizeInput();
  state.busyStarting = true;
  persistChatNow();
  renderMessages();
  renderStatus();
  requestAnimationFrame(() => {
    const log = $('#chatLog');
    log.scrollTop = log.scrollHeight;
  });

  try {
    const task = await send('task:start', { goal, tabId: fresh.id, mode });
    applyTask(task);
  } catch (error) {
    assistantMessage.status = 'error';
    assistantMessage.phase = 'error';
    assistantMessage.error = {
      message: error.message || 'The task could not be started.',
      hint: error.hint || '',
    };
    state.busyStarting = false;
    persistChatNow();
    renderMessages();
    renderStatus();
  }
}

async function stopTask() {
  const message = state.chat.find(
    (item) => item.role === 'assistant' && item.id === state.activeAssistantId && item.status === 'running',
  );
  if (message) {
    message.phase = 'stopping';
    message.liveActivity = 'Stopping…';
    renderMessages();
  }
  try {
    const data = await send('task:stop');
    if (data?.task) applyTask(data.task);
  } catch (error) {
    toast(error.message || 'Could not stop the task.', 'error');
  }
}

/* ------------------------------------------------------------------- tabs */

async function requestTabsPermission() {
  if (!chrome.permissions?.request) {
    toast('Chrome tab-list permission is unavailable. Reload the extension and try again.', 'error');
    return false;
  }
  try {
    const granted = await chrome.permissions.request({ permissions: ['tabs'] });
    if (!granted) {
      toast('Tab-list access was not granted. You can still use the current tab.', 'warn');
      return false;
    }
    await refreshTabInfo({ quiet: true });
    toast('Tab titles are now visible.');
    return true;
  } catch {
    toast('Chrome could not grant tab-list access.', 'error');
    return false;
  }
}

async function ensureTabAccess(tab) {
  if (!tab) return false;
  if (tab.restricted || !tab.supported) {
    toast(tab.reason || 'Chrome blocks extensions on this page.', 'error');
    return false;
  }
  if (tab.permission === 'granted') return true;

  if (!tab.url) {
    const granted = await requestTabsPermission();
    if (!granted) return false;
    const refreshed = state.tabs.find((item) => item.id === tab.id);
    if (!refreshed) {
      toast('That tab was closed.', 'error');
      return false;
    }
    if (!refreshed.url) {
      toast('Chrome still hides this tab’s address. Reload it, or open a normal website tab.', 'warn');
      return false;
    }
    return ensureTabAccess(refreshed);
  }

  const origin = originPatternFor(tab.url);
  if (!origin) {
    toast('This tab’s address cannot be covered by a website permission.', 'error');
    return false;
  }
  if (!chrome.permissions?.request) {
    toast('Chrome website permission support is unavailable. Reload the extension and try again.', 'error');
    return false;
  }

  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (!granted) {
      toast(`Access to ${tabHost(tab.url) || 'this website'} was not granted.`, 'error');
      return false;
    }
    await refreshTabInfo({ quiet: true });
    return true;
  } catch {
    toast('Chrome could not grant access to this website.', 'error');
    return false;
  }
}

async function selectTab(tab) {
  if (!tab) return;
  if (tab.restricted || !tab.supported) {
    toast(tab.reason || 'This page cannot be read by the extension.', 'error');
    return;
  }
  if (!tab.url) {
    const granted = await requestTabsPermission();
    if (!granted) return;
    const refreshed = state.tabs.find((item) => item.id === tab.id);
    if (!refreshed) {
      toast('That tab was closed.', 'error');
      return;
    }
    if (!refreshed.url) {
      toast('Chrome still hides this tab’s address. Reload it, or open a normal website tab.', 'warn');
      return;
    }
    await selectTab(refreshed);
    return;
  }
  if (tab.permission !== 'granted') {
    const granted = await ensureTabAccess(tab);
    if (!granted) return;
  }
  state.selectedTabId = tab.id;
  renderTabBar();
  renderStatus();
  showView('main');
  setTimeout(() => $('#goalInput')?.focus({ preventScroll: true }), 30);
}

function renderTabs() {
  const list = $('#tabList');
  list.replaceChildren();
  const filtered = filterTabs(state.tabs, state.tabFilter);
  const ordered = sortTabsForPicker(filtered, {
    activeTabId: state.activeTabId,
    selectedTabId: state.selectedTabId,
  });

  $('#tabEmpty').hidden = ordered.length > 0;
  $('#tabsSub').textContent = state.tabsMeta.total
    ? `${filtered.length} of ${state.tabsMeta.total} open tab${state.tabsMeta.total === 1 ? '' : 's'}`
    : 'Choose the tab the agent should work with';

  const showBanner =
    !state.tabsMeta.hasTabsPermission && state.tabs.some((tab) => !tab.url);
  $('#tabsPermissionBanner').hidden = !showBanner;

  for (const tab of ordered) {
    const selected = tab.id === state.selectedTabId;
    const row = el('button', {
      class: 'tab-row',
      type: 'button',
      dataset: {
        selected: String(selected),
        restricted: String(Boolean(tab.restricted)),
      },
      'aria-pressed': String(selected),
      title: tab.reason || tabTitleFor(tab),
    });

    const fav = el('span', { class: 'tab-fav', 'aria-hidden': 'true' });
    setFavicon(fav, tab);

    const main = el('span', { class: 'tab-main' });
    const subtitle = tab.restricted
      ? 'Not available to extensions'
      : tab.url
        ? tabHost(tab.url) || tab.url
        : 'Address hidden by Chrome';
    main.append(
      el('span', { class: 'tab-name', text: tabTitleFor(tab) }),
      el('span', { class: 'tab-url', text: subtitle }),
    );

    const badges = el('span', { class: 'tab-badges' });
    if (tab.active) badges.append(el('span', { class: 'badge badge-active', text: 'Active' }));
    if (tab.restricted) badges.append(el('span', { class: 'badge badge-restricted', text: 'Restricted' }));
    else if (tab.permission === 'granted') {
      badges.append(el('span', { class: 'badge badge-ready', text: 'Ready' }));
    } else if (tab.permission === 'needed') {
      badges.append(el('span', { class: 'badge badge-access', text: 'Allow' }));
    } else if (!tab.url) {
      badges.append(el('span', { class: 'badge', text: 'Hidden' }));
    }
    if (selected) {
      badges.append(
        el(
          'span',
          { class: 'check-icon', 'aria-label': 'Selected' },
          el(
            'svg',
            { viewBox: '0 0 16 16', width: '13', height: '13', fill: 'none', 'aria-hidden': 'true' },
            el('path', {
              d: 'm3.5 8.4 3 3 6-6.4',
              stroke: 'currentColor',
              'stroke-width': '1.7',
              'stroke-linecap': 'round',
              'stroke-linejoin': 'round',
            }),
          ),
        ),
      );
    }

    row.append(fav, main, badges);
    row.addEventListener('click', () => {
      void selectTab(tab);
    });
    list.append(el('li', {}, row));
  }

  $('#tabFootNote').textContent = state.tabsMeta.truncated
    ? `Showing the first ${state.tabs.length} tabs. Close some tabs to see the rest.`
    : 'Only the tab you select is read.';
}

async function refreshTabInfo({ quiet = false } = {}) {
  const [infoResult, tabsResult] = await Promise.allSettled([send('app:info'), send('tabs:list')]);
  const info = infoResult.status === 'fulfilled' ? infoResult.value : null;
  const tabsData = tabsResult.status === 'fulfilled' ? tabsResult.value : null;

  if (info) {
    state.settings = { ...DEFAULT_SETTINGS, ...(info.settings || {}) };
    state.appVersion = info.version || '';
    if (info.task && !state.task) state.task = info.task;
    applyTheme();
  }

  if (tabsData) {
    state.tabs = Array.isArray(tabsData.tabs) ? tabsData.tabs : [];
    state.tabsMeta = {
      total: Number(tabsData.total) || state.tabs.length,
      truncated: tabsData.truncated === true,
      hasTabsPermission: tabsData.hasTabsPermission === true,
      canRequestTabs: tabsData.canRequestTabs !== false,
    };
    state.activeTabId = tabsData.activeTabId ?? null;
  } else if (info?.tab) {
    // Degraded path: the worker could not list tabs, but the active tab is known.
    state.tabs = [info.tab];
    state.activeTabId = info.tab.id;
    state.tabsMeta = { total: 1, truncated: false, hasTabsPermission: false, canRequestTabs: false };
  }

  if (!state.selectedTabId || !state.tabs.some((tab) => tab.id === state.selectedTabId)) {
    state.selectedTabId = state.activeTabId ?? state.tabs[0]?.id ?? null;
  }

  renderTabBar();
  renderTabs();
  renderPreferences();
  renderChatMeta();
  renderStatus();

  if (!quiet && infoResult.status === 'rejected' && tabsResult.status === 'rejected') {
    toast('Could not read the current tab. Reload the extension and try again.', 'error');
  }
}

/* ------------------------------------------------------------- preferences */

function renderPreferences() {
  $('#prefMaxSteps').value = state.settings.maxSteps ?? DEFAULT_SETTINGS.maxSteps;
  $('#prefShowHud').checked = state.settings.showHud !== false;
  $('#prefJsonMode').checked = state.settings.jsonMode === true;
  $('#prefPrivateHttp').checked = state.settings.allowPrivateHttp === true;
  $('#prefTheme').value = ['auto', 'light', 'dark'].includes(state.settings.theme)
    ? state.settings.theme
    : 'auto';
  $('#versionLabel').textContent = state.appVersion || '—';
}

async function savePreferences(patch) {
  const before = { ...state.settings };
  state.settings = { ...state.settings, ...patch };
  applyTheme();
  renderStatus();
  renderPreferences();
  try {
    const data = await send('settings:save', { settings: patch });
    state.settings = { ...state.settings, ...(data.settings || {}) };
    applyTheme();
    toast('Preferences saved');
  } catch (error) {
    state.settings = before;
    applyTheme();
    toast(error.message || 'Could not save preferences.', 'error');
  }
  renderPreferences();
  renderStatus();
}

async function renderSiteAccess() {
  const list = $('#siteAccessList');
  const empty = $('#siteAccessEmpty');
  list.replaceChildren();

  if (!chrome.permissions?.getAll) {
    empty.hidden = false;
    empty.textContent = 'Chrome did not report website access for this extension.';
    return;
  }

  let origins = [];
  try {
    const all = await chrome.permissions.getAll();
    origins = (Array.isArray(all?.origins) ? all.origins : [])
      .filter((origin) => /^https?:\/\//i.test(origin))
      .sort();
  } catch {
    origins = [];
  }

  empty.hidden = origins.length > 0;
  empty.textContent = 'No website access has been granted.';

  for (const origin of origins) {
    const host = origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
    const row = el('li', { class: 'access-row' }, el('span', { text: host, title: origin }));
    row.append(
      el('button', {
        class: 'link-btn',
        type: 'button',
        text: 'Revoke',
        'aria-label': `Revoke access to ${host}`,
        onclick: async () => {
          try {
            const removed = await chrome.permissions.remove({ origins: [origin] });
            state.permissionOrigins.delete(origin);
            await refreshPermissionGrants(state.providers);
            await refreshTabInfo({ quiet: true });
            await renderSiteAccess();
            toast(removed ? `Access to ${host} was removed.` : 'No permission grant was found.');
          } catch {
            toast('Chrome could not remove this permission.', 'error');
          }
        },
      }),
    );
    list.append(row);
  }
}

async function clearConversation() {
  if (state.task?.status === 'running') {
    toast('Stop the running task before clearing the conversation.', 'warn');
    return;
  }
  state.chat = [];
  state.activeAssistantId = null;
  state.openSteps.clear();
  state.clearPending = false;
  $('#clearConfirm').hidden = true;
  await state.chatStore.clear();
  renderMessages();
  renderChatMeta();
  toast('Conversation cleared');
}

/* ---------------------------------------------------------- provider list */

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

    const metaParts = [provider.model || 'No model set', hostOf(provider)];
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
      'aria-pressed': String(isActive),
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

    list.append(
      el('li', { class: 'provider-row', dataset: { active: String(isActive) } }, openButton, stateButton),
    );
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
    renderStatus();
    if (state.view === 'editor') renderEditor();
    const provider = state.providers.find((item) => item.id === state.activeId);
    toast(`${provider?.name || 'Provider'} is now active`);
    return true;
  } catch (error) {
    toast(error.message || 'Could not activate that provider.', 'error');
    return false;
  }
}

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
  $('#editorSub').textContent = draft.model
    ? `${draft.model} · ${hostOf(draft)}`
    : 'OpenAI-compatible chat completions';
  $('#editorActivePill').hidden = draft.id !== state.activeId;
  $('#activateBtn').textContent = draft.id === state.activeId ? 'Active provider' : 'Use this provider';
  $('#activateBtn').disabled = draft.id === state.activeId;
  $('#deleteBtn').hidden = false;

  renderEndpointPreview();
  renderCustomWarning();
  renderTestResult();
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
  for (const id of [
    'errName',
    'errBaseUrl',
    'errModel',
    'errEndpointPath',
    'errTemperature',
    'errMaxTokens',
    'errParams',
    'errExtraHeaders',
    'errApiKey',
  ]) {
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

  if (draft.__json?.params) check.errors.params = draft.__json.params;
  if (draft.__json?.extraHeaders) check.errors.extraHeaders = draft.__json.extraHeaders;

  // A missing key blocks running, not saving.
  if (draft.apiKey) delete check.errors.apiKey;

  return { ...check, valid: Object.keys(check.errors).length === 0 };
}

function renderValidation() {
  const { errors } = validateDraft();
  for (const key of [
    'name',
    'baseUrl',
    'model',
    'endpointPath',
    'temperature',
    'maxTokens',
    'params',
    'extraHeaders',
  ]) {
    setFieldError(key, errors[key] || '');
  }
  renderEndpointPreview();
  renderCustomWarning();

  const draft = state.draft;
  if (draft) {
    $('#editorTitle').textContent = state.draftIsNew ? 'New provider' : draft.name || 'Edit provider';
    $('#editorSub').textContent = draft.model
      ? `${draft.model} · ${hostOf(draft)}`
      : 'OpenAI-compatible chat completions';
  }
}

function canAutosave() {
  const draft = state.draft;
  if (!draft) return false;
  if (!String(draft.name || '').trim()) return false;
  if (draft.__json?.params || draft.__json?.extraHeaders) return false;
  if (draft.baseUrl) {
    const { errors } = validateDraft();
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

    setSaveState('saved', `Saved · ${timeOf(Date.now())}`);
    renderProviderList();
    renderStatus();
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

/* ------------------------------------------------------------------- test */

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
  content_filtered: { tone: 'error', title: 'Response blocked' },
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

/* --------------------------------------------------------------- composer */

function autosizeInput() {
  const input = $('#goalInput');
  input.style.height = 'auto';
  const height = input.scrollHeight || 28;
  input.style.height = `${Math.min(112, height)}px`;
}

/* ------------------------------------------------------------------ boot */

async function refreshProviders() {
  try {
    const data = await send('providers:list');
    state.providers = data.providers || [];
    state.activeId = data.activeId || state.providers[0]?.id || null;
    await refreshPermissionGrants(state.providers);
    renderProviderList();
    renderStatus();
  } catch (error) {
    toast(error.message || 'Could not load providers.', 'error');
  }
}

async function reconcileTask() {
  try {
    const task = await send('task:state');
    if (!task) {
      renderStatus();
      return;
    }
    applyTask(task, { createIfMissing: task.status === 'running' });
    if (task.status === 'running') setTimeout(() => void send('task:state').then((next) => next && applyTask(next)), 800);
  } catch {
    renderStatus();
  }
}

async function closeEditor() {
  if (state.dirty) {
    const saved = await saveDraft();
    if (!saved) {
      toast('Fix the highlighted fields before leaving.', 'error');
      return;
    }
  }
  renderProviderList();
  openSettings('ai');
}

function bindEvents() {
  let tabRefreshTimer;
  const scheduleTabRefresh = () => {
    clearTimeout(tabRefreshTimer);
    tabRefreshTimer = setTimeout(() => void refreshTabInfo({ quiet: true }), 180);
  };
  chrome.tabs?.onUpdated?.addListener((tabId, change) => {
    if (tabId === state.selectedTabId || state.view === 'tabs') {
      if (change.status === 'complete' || change.url || change.title) scheduleTabRefresh();
    }
  });
  chrome.tabs?.onRemoved?.addListener(scheduleTabRefresh);
  chrome.tabs?.onActivated?.addListener(scheduleTabRefresh);
  $('#taskMode').addEventListener('change', () => {
    $('#modeNote').textContent = $('#taskMode').value === 'read'
      ? 'No clicks, typing, or navigation' : 'Can interact with this tab';
  });
  $('#providerChip').addEventListener('click', () => openSettings('ai'));
  $('#settingsBtn').addEventListener('click', () => openSettings('ai'));
  $('#settingsBack').addEventListener('click', () => showView('main'));
  $('#tabAi').addEventListener('click', () => setSettingsPanel('ai'));
  $('#tabBehavior').addEventListener('click', () => setSettingsPanel('behavior'));
  $('#addProviderBtn').addEventListener('click', () => showView('new'));
  $('#newBack').addEventListener('click', () => openSettings('ai'));
  $('#customProviderBtn').addEventListener('click', () => startNewProvider(null));
  $('#editorBack').addEventListener('click', () => void closeEditor());

  $('#tabsBtn').addEventListener('click', () => {
    renderTabs();
    showView('tabs');
    void refreshTabInfo({ quiet: true }).then(() => renderTabs());
  });
  $('#tabsBack').addEventListener('click', () => showView('main'));
  $('#tabsDone').addEventListener('click', () => showView('main'));
  $('#tabsRefreshBtn').addEventListener('click', () => {
    void refreshTabInfo({ quiet: true }).then(() => {
      renderTabs();
      toast('Tab list refreshed');
    });
  });
  $('#grantTabsBtn').addEventListener('click', () => void requestTabsPermission());
  $('#tabSearch').addEventListener('input', () => {
    state.tabFilter = $('#tabSearch').value;
    renderTabs();
  });
  $('#refreshTabBtn').addEventListener('click', () => {
    void refreshTabInfo().then(() => toast('Tab information refreshed'));
  });
  $('#tabPermBtn').addEventListener('click', async () => {
    const tab = selectedTab();
    if (!tab) {
      toast('Open a website tab first.', 'warn');
      return;
    }
    if (tab.restricted) {
      toast(tab.reason || 'This page cannot be read.', 'error');
      return;
    }
    if (tab.permission === 'needed' || tab.permission === 'unknown' || !tab.url) {
      const granted = await ensureTabAccess(tab);
      if (granted) {
        renderTabBar();
        renderStatus();
        toast('This tab can now be read by the agent.');
      }
      return;
    }
    renderTabs();
    showView('tabs');
  });

  $('#runBtn').addEventListener('click', () => void startTask());
  $('#stopBtn').addEventListener('click', () => void stopTask());

  const input = $('#goalInput');
  input.addEventListener('input', () => {
    autosizeInput();
    renderComposer();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!$('#runBtn').disabled) void startTask();
    }
  });

  for (const suggestion of document.querySelectorAll('.suggestion')) {
    suggestion.addEventListener('click', () => {
      input.value = suggestion.dataset.prompt || suggestion.textContent || '';
      autosizeInput();
      renderComposer();
      input.focus({ preventScroll: true });
    });
  }

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
    const keyInput = $('#fApiKey');
    const button = $('#toggleKey');
    const show = keyInput.type === 'password';
    keyInput.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    keyInput.focus({ preventScroll: true });
  });

  $('#advancedToggle').addEventListener('click', () => setAdvanced(!state.advancedOpen));
  $('#testBtn').addEventListener('click', () => void testProviderConnection());
  $('#fetchModelsBtn').addEventListener('click', () => void fetchModels());
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
      toast(
        removed
          ? `Access to ${new URL(provider.baseUrl).host} was removed.`
          : 'No permission grant was found.',
      );
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
    const isSaved = state.providers.some((provider) => provider.id === id);
    clearTimeout(state.saveTimer);
    state.dirty = false;
    try {
      if (isSaved) {
        const data = await send('providers:delete', { id });
        state.activeId = data.activeId || null;
      }
      state.providers = state.providers.filter((provider) => provider.id !== id);
      state.draft = null;
      state.draftIsNew = false;
      state.deletePending = false;
      renderProviderList();
      renderStatus();
      openSettings('ai');
      toast('Provider deleted');
    } catch (error) {
      toast(error.message || 'Could not delete this provider.', 'error');
    }
  });

  // Preferences
  $('#prefMaxSteps').addEventListener('change', () => {
    const value = Number($('#prefMaxSteps').value);
    void savePreferences({ maxSteps: Number.isFinite(value) ? value : DEFAULT_SETTINGS.maxSteps });
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
  $('#prefTheme').addEventListener('change', () =>
    savePreferences({ theme: $('#prefTheme').value }),
  );

  $('#refreshAccessBtn').addEventListener('click', () => void renderSiteAccess());

  $('#clearChatBtn').addEventListener('click', () => {
    if (!state.chat.length) return;
    state.clearPending = true;
    $('#clearConfirm').hidden = false;
    $('#clearConfirmBtn').focus({ preventScroll: true });
  });
  $('#clearCancel').addEventListener('click', () => {
    state.clearPending = false;
    $('#clearConfirm').hidden = true;
    $('#clearChatBtn').focus({ preventScroll: true });
  });
  $('#clearConfirmBtn').addEventListener('click', () => void clearConversation());

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.view === 'editor') {
      event.preventDefault();
      $('#editorBack').click();
    } else if (state.view === 'new') {
      openSettings('ai');
    } else if (state.view === 'settings' || state.view === 'tabs') {
      showView('main');
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'fta:progress' && message.task) {
      const task = message.task;
      const known =
        (state.task?.id && state.task.id === task.id) ||
        state.chat.some((item) => item.taskId === task.id);
      // Ignore a late broadcast from an older run after a new one has started.
      if (!known && state.task?.status === 'running') return;
      if (known) applyTask(task);
    }
    return false;
  });

  // Best-effort flush when the popup closes.
  window.addEventListener('pagehide', () => {
    void state.chatStore.save(state.chat);
  });
}

async function init() {
  applyTheme();
  bindEvents();
  renderPresetGrid();
  renderProviderList();
  renderPreferences();
  renderChatMeta();
  renderStatus();
  renderTabBar();
  renderMessages();

  state.chat = await state.chatStore.load();
  renderMessages();
  renderChatMeta();

  await Promise.all([refreshProviders(), refreshTabInfo()]);
  await reconcileTask();

  renderMessages();
  renderStatus();
  renderTabBar();

  if (!state.providers.length) {
    openSettings('ai');
  } else if (state.view === 'main') {
    setTimeout(() => $('#goalInput')?.focus({ preventScroll: true }), 40);
  }
  autosizeInput();
  renderComposer();
}

void init();
