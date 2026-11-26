/**
 * End-to-end test of the service worker: message routing, provider CRUD,
 * connection testing, tab discovery and a full agent run against fake tabs.
 *
 * Node's test runner executes the tests in this file sequentially, so they
 * share one booted worker (just like the real extension).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorageArea, jsonResponse } from './helpers.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => JSON.parse(JSON.stringify(value));

const local = createStorageArea();
const session = createStorageArea();
const runtimeListeners = [];
const broadcasts = [];
const executed = [];
const fetchCalls = [];
const sentTabMessages = [];
const permissionChecks = [];
const siteGrants = new Set();

let modelCalls = 0;
let holdNextFetch = false;
let releaseHeldFetch = null;
let hasHostPermission = true;
let hasTabsPermission = true;

const tabs = [
  {
    id: 7,
    windowId: 1,
    index: 0,
    status: 'complete',
    active: true,
    title: 'Shop',
    url: 'https://shop.example.com/products',
    favIconUrl: 'https://shop.example.com/favicon.ico',
  },
  {
    id: 8,
    windowId: 1,
    index: 1,
    status: 'complete',
    title: 'Docs',
    url: 'https://docs.example.org/guide',
  },
  {
    id: 9,
    windowId: 1,
    index: 2,
    status: 'complete',
    title: 'Settings',
    url: 'chrome://settings',
  },
  {
    id: 10,
    windowId: 2,
    index: 0,
    status: 'complete',
    title: '',
    url: '',
  },
];
const tab = tabs[0];

function findTab(tabId) {
  return tabs.find((item) => item.id === tabId) || null;
}

let loseActionResponse = false;
let firstModelAction = { type: 'click', elementId: 1 };

function contentAgent(message, target = tab) {
  if (message.type === 'fta:ping') return { ok: true, url: target.url, context: { documentToken: `doc:${target.url}` } };
  if (message.type === 'fta:snapshot') {
    return {
      ok: true,
      snapshot: {
        url: target.url,
        context: { documentToken: `doc:${target.url}`, url: target.url },
        title: target.title,
        elements: [{ id: 1, tag: 'button', label: 'Search', inViewport: true }],
        headings: [],
        text: 'Products',
        iframes: [],
      },
    };
  }
  if (message.type === 'fta:execute') {
    executed.push({ tabId: target.id, action: message.action });
    if (loseActionResponse) throw new Error('Document channel closed after dispatch');
    if (message.action.type === 'navigate') target.url = message.action.url;
    return { ok: true, observation: `Did ${message.action.type} on ${target.title}.` };
  }
  if (message.type === 'fta:hud') return { ok: true };
  return { ok: false, error: 'unknown message' };
}

globalThis.chrome = {
  storage: { local, session },
  permissions: {
    contains: async (query = {}) => {
      if (Array.isArray(query.permissions) && query.permissions.includes('tabs')) {
        return hasTabsPermission;
      }
      const origins = Array.isArray(query.origins) ? query.origins : [];
      permissionChecks.push(...origins);
      if (!origins.length) return false;
      return origins.every((origin) =>
        origin.includes('llm.example.net') ? hasHostPermission : siteGrants.has(origin),
      );
    },
  },
  runtime: {
    id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getManifest: () => ({ version: '1.0.0' }),
    getPlatformInfo: (callback) => callback && callback({}),
    lastError: undefined,
    sendMessage: async (message) => {
      broadcasts.push(clone(message));
      throw new Error('no receiving popup');
    },
  },
  tabs: {
    query: async () => tabs,
    get: async (tabId) => {
      const found = findTab(tabId);
      if (!found) throw new Error(`No tab with id ${tabId}`);
      return found;
    },
    sendMessage: async (tabId, message) => {
      sentTabMessages.push({ tabId, type: message.type });
      const target = findTab(tabId);
      if (!target) throw new Error('The tab was closed.');
      return contentAgent(message, target);
    },
  },
  scripting: { executeScript: async () => {} },
};

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init, body: JSON.parse(init.body) });
  if (holdNextFetch) {
    holdNextFetch = false;
    await new Promise((resolve) => {
      releaseHeldFetch = resolve;
    });
  }
  modelCalls += 1;
  const content =
    modelCalls === 1
      ? JSON.stringify({
          thought: 'Click search',
          plan: ['click', 'finish'],
          action: firstModelAction,
        })
      : JSON.stringify({ thought: 'All done', done: true, answer: 'Searched the catalogue.' });
  return jsonResponse({
    body: { model: 'test-model', choices: [{ message: { content }, finish_reason: 'stop' }] },
  });
};

await import('../src/background.js');
await delay(80);

const listener = runtimeListeners[0];

function send(type, payload = {}, sender = {
  id: 'test-extension',
  url: 'chrome-extension://test-extension/src/popup/popup.html',
}) {
  return new Promise((resolve) => {
    listener({ type, ...payload }, sender, resolve);
    setTimeout(() => resolve(undefined), 4000);
  });
}

async function waitForTask() {
  let state = null;
  for (let i = 0; i < 80; i += 1) {
    await delay(25);
    state = (await send('task:state')).data;
    if (state && state.status !== 'running') return state;
  }
  throw new Error('the task did not settle');
}

let seeded;
let custom;
let taskId;

test('seeds one provider on first run', async () => {
  assert.ok(listener, 'background registered a message listener');
  const response = await send('providers:list');
  assert.equal(response.ok, true);
  assert.equal(response.data.providers.length, 1);
  seeded = response.data.providers[0];
  assert.equal(seeded.name, 'NVIDIA NIM');
  assert.equal(response.data.activeId, seeded.id);
  assert.ok(local.dump()[`fta.provider.${seeded.id}`], 'provider stored under its own key');
});

test('saves a custom provider without stealing active status', async () => {
  const response = await send('providers:save', {
    provider: {
      id: 'p_custom000000000001',
      name: 'My endpoint',
      type: 'custom',
      baseUrl: 'https://llm.example.net/v1',
      apiKey: 'sk-custom-secret-9876',
      model: 'custom-7b',
      params: { top_p: 0.8 },
    },
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.created, true);
  custom = response.data.provider;
  assert.equal(custom.id, 'p_custom000000000001');
  assert.equal(custom.apiKey, 'sk-custom-secret-9876');
  assert.equal(response.data.activeId, seeded.id);
});

test('refuses hard-invalid endpoints at save time', async () => {
  const response = await send('providers:save', {
    provider: { id: 'p_bad00000000000001', name: 'Bad', baseUrl: 'file:///etc/passwd', model: 'x' },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.field, 'baseUrl');
  assert.match(response.error.message, /Unsupported URL scheme/i);
  assert.equal(local.dump()['fta.provider.p_bad00000000000001'], undefined);
});

test('activates a provider', async () => {
  const response = await send('providers:activate', { id: custom.id });
  assert.equal(response.ok, true);
  assert.equal(response.data.activeId, custom.id);
});

test('blocks API calls until the provider host permission exists', async () => {
  const before = fetchCalls.length;
  hasHostPermission = false;
  const denied = await send('providers:test', { id: custom.id });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'host_permission_required');
  assert.equal(fetchCalls.length, before, 'no request leaves before permission is granted');
  assert.ok(permissionChecks.includes('https://llm.example.net/*'));
  hasHostPermission = true;
});

test('tests a connection and never echoes the key', async () => {
  const response = await send('providers:test', { id: custom.id });
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'success');
  assert.equal(response.data.host, 'llm.example.net');
  assert.equal(JSON.stringify(response.data).includes('sk-custom-secret-9876'), false);

  const call = fetchCalls.at(-1);
  assert.equal(call.url, 'https://llm.example.net/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-custom-secret-9876');
  assert.equal(call.body.top_p, 0.8, 'custom parameters merged into the request');
});

test('tests unsaved drafts, falling back to the stored key', async () => {
  const response = await send('providers:test', {
    provider: { ...custom, model: 'draft-model', apiKey: '' },
  });
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'success');
  assert.equal(fetchCalls.at(-1).body.model, 'draft-model');
});

test('runs a full task through the page agent and records progress', async () => {
  executed.length = 0;
  modelCalls = 0;
  fetchCalls.length = 0;

  const response = await send('task:start', { goal: 'Search for shoes' });
  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'running');
  assert.equal(response.data.tabId, tab.id);
  assert.equal(response.data.tabHost, 'shop.example.com');
  taskId = response.data.id;

  const state = await waitForTask();
  assert.equal(state.status, 'done');
  assert.equal(state.answer, 'Searched the catalogue.');
  assert.equal(state.steps.length, 2);
  assert.deepEqual(executed, [{ tabId: tab.id, action: { type: 'click', elementId: 1 } }]);
  assert.equal(fetchCalls[0].body.model, 'custom-7b');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer sk-custom-secret-9876');
  assert.match(fetchCalls[0].body.messages[0].content, /autonomous browser agent/i);
  assert.match(fetchCalls[0].body.messages[1].content, /Search for shoes/);
  assert.equal(state.provider.model, 'custom-7b');
  assert.ok(session.dump()['fta.task'], 'task snapshot persisted for a reopened popup');

  const progress = broadcasts.filter((message) => message.type === 'fta:progress');
  assert.ok(progress.length >= 2, 'progress broadcasts emitted');
  assert.equal(progress.at(-1).task.status, 'done');
  assert.ok(
    progress.some((message) => message.task.phase === 'reading'),
    'reading phase is reported',
  );
  assert.equal(
    JSON.stringify(broadcasts).includes('sk-custom-secret-9876'),
    false,
    'API key never appears in progress messages',
  );
  assert.ok(taskId);
});

test('a late model response cannot overwrite a stopped task', async () => {
  await send('providers:activate', { id: custom.id });
  holdNextFetch = true;
  const started = await send('task:start', { goal: 'Wait for an answer' });
  assert.equal(started.ok, true);
  for (let i = 0; i < 40 && !releaseHeldFetch; i += 1) await delay(25);
  assert.equal(typeof releaseHeldFetch, 'function', 'the worker reached the pending model request');

  await send('task:stop');
  await delay(2650); // stop safety settlement if a request/page message ignores cancellation
  let state = (await send('task:state')).data;
  assert.equal(state.status, 'stopped');

  releaseHeldFetch();
  releaseHeldFetch = null;
  await delay(80);
  state = (await send('task:state')).data;
  assert.equal(state.status, 'stopped', 'a late completion cannot change the settled state');
});

test('rejects empty goals and providers without a key', async () => {
  let response = await send('task:start', { goal: '   ' });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /Describe what the agent should do/i);

  await send('providers:activate', { id: seeded.id });
  response = await send('task:start', { goal: 'Do something' });
  assert.equal(response.ok, false);
  assert.match(response.error.message, /API key/i);
  assert.equal(response.error.field, 'apiKey');
});

test('switching providers preserves every record', async () => {
  const listed = (await send('providers:list')).data;
  const customAfter = listed.providers.find((provider) => provider.id === custom.id);
  assert.equal(customAfter.apiKey, 'sk-custom-secret-9876');
  assert.equal(customAfter.model, 'custom-7b');
  assert.equal(listed.providers.find((provider) => provider.id === seeded.id).name, 'NVIDIA NIM');
});

test('deleting the active provider promotes the other one', async () => {
  const response = await send('providers:delete', { id: seeded.id });
  assert.equal(response.ok, true);
  assert.equal(response.data.activeId, custom.id);
  assert.equal(local.dump()[`fta.provider.${seeded.id}`], undefined);
});

test('persists and clamps settings', async () => {
  let response = await send('settings:save', { settings: { maxSteps: 3, showHud: false } });
  assert.equal(response.ok, true);
  assert.equal(response.data.settings.maxSteps, 3);
  assert.equal(response.data.settings.showHud, false);
  assert.equal(response.data.settings.allowPrivateHttp, false);
  assert.equal(response.data.settings.theme, 'auto');

  response = await send('settings:save', { settings: { maxSteps: 999, theme: 'neon' } });
  assert.equal(response.data.settings.maxSteps, 20);
  assert.equal(response.data.settings.theme, 'auto', 'unknown themes fall back to auto');

  response = await send('settings:save', { settings: { theme: 'dark' } });
  assert.equal(response.data.settings.theme, 'dark');

  await send('settings:save', { settings: { showHud: true, theme: 'auto' } });
});

test('app:info reports the current tab, restrictions and settings', async () => {
  const response = await send('app:info');
  assert.equal(response.ok, true);
  assert.equal(response.data.tab.url, tab.url);
  assert.equal(response.data.tab.supported, true);
  assert.equal(response.data.tab.restricted, false);
  assert.equal(response.data.tab.host, 'shop.example.com');
  assert.equal(response.data.version, '1.0.0');
  assert.equal(JSON.stringify(response.data).includes('sk-custom-secret-9876'), false);
});

test('tabs:list returns bounded metadata and per-tab access state', async () => {
  const response = await send('tabs:list');
  assert.equal(response.ok, true);
  const data = response.data;
  assert.equal(data.total, tabs.length);
  assert.equal(data.activeTabId, tab.id);
  assert.equal(data.hasTabsPermission, true);
  assert.equal(data.tabs.length, tabs.length);

  const shop = data.tabs.find((item) => item.id === 7);
  assert.equal(shop.active, true);
  assert.equal(shop.permission, 'granted');
  assert.equal(shop.restricted, false);
  assert.equal(shop.favIconUrl, 'https://shop.example.com/favicon.ico');

  const docs = data.tabs.find((item) => item.id === 8);
  assert.equal(docs.permission, 'needed');
  assert.equal(docs.restricted, false);

  const settings = data.tabs.find((item) => item.id === 9);
  assert.equal(settings.permission, 'unavailable');
  assert.equal(settings.restricted, true);
  assert.match(settings.reason, /Chrome internal pages/i);

  const hidden = data.tabs.find((item) => item.id === 10);
  assert.equal(hidden.permission, 'unknown');
  assert.equal(hidden.restricted, false, 'a hidden URL is unknown, not restricted');

  hasTabsPermission = false;
  const noPermission = await send('tabs:list');
  assert.equal(noPermission.data.hasTabsPermission, false);
  hasTabsPermission = true;
});

test('a task cannot run on another tab without site access', async () => {
  await send('providers:activate', { id: custom.id });
  modelCalls = 0;
  fetchCalls.length = 0;
  const before = sentTabMessages.filter((message) => message.tabId === 8).length;

  const response = await send('task:start', { goal: 'Read the docs', tabId: 8 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'tab_permission_required');
  assert.match(response.error.message, /docs\.example\.org/);
  assert.equal(fetchCalls.length, 0, 'no provider request before tab access exists');
  assert.equal(
    sentTabMessages.filter((message) => message.tabId === 8).length,
    before,
    'the page agent was never injected into the unpermitted tab',
  );
});

test('a granted tab can be targeted explicitly', async () => {
  siteGrants.add('https://docs.example.org/*');
  modelCalls = 0;
  fetchCalls.length = 0;
  executed.length = 0;

  const response = await send('task:start', { goal: 'Read the docs', tabId: 8 });
  assert.equal(response.ok, true);
  assert.equal(response.data.tabId, 8);
  assert.equal(response.data.tabTitle, 'Docs');
  assert.equal(response.data.tabHost, 'docs.example.org');

  const state = await waitForTask();
  assert.equal(state.status, 'done');
  assert.equal(state.tabId, 8);
  assert.deepEqual(executed, [{ tabId: 8, action: { type: 'click', elementId: 1 } }]);
  assert.ok(
    sentTabMessages.some((message) => message.tabId === 8 && message.type === 'fta:snapshot'),
    'the snapshot came from the selected tab',
  );
});

test('restricted, closed and unloaded tabs fail with actionable errors', async () => {
  let response = await send('task:start', { goal: 'Change settings', tabId: 9 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'tab_restricted');
  assert.match(response.error.message, /Chrome internal pages/i);

  response = await send('task:start', { goal: 'Read it', tabId: 999 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'tab_unavailable');
  assert.match(response.error.message, /closed/i);

  response = await send('task:start', { goal: 'Read it', tabId: 10 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'tab_unavailable');
});

test('content-script senders cannot read provider records or API keys', () => {
  let replied = false;
  const accepted = listener(
    { type: 'providers:list' },
    { id: 'test-extension', url: tab.url, tab: { id: tab.id } },
    () => {
      replied = true;
    },
  );
  assert.equal(accepted, false);
  assert.equal(replied, false);
});

test('the HUD can stop only the task running in its own tab', async () => {
  await send('providers:activate', { id: custom.id });
  holdNextFetch = true;
  const started = await send('task:start', { goal: 'Wait a moment' });
  assert.equal(started.ok, true);
  for (let i = 0; i < 40 && !releaseHeldFetch; i += 1) await delay(25);

  let replied = false;
  const wrongTab = listener(
    { type: 'task:stop', source: 'hud' },
    { id: 'test-extension', tab: { id: 8 } },
    () => {
      replied = true;
    },
  );
  assert.equal(wrongTab, false);
  assert.equal(replied, false);

  const stopResponse = await new Promise((resolve) => {
    listener({ type: 'task:stop', source: 'hud' }, { id: 'test-extension', tab: { id: tab.id } }, resolve);
  });
  assert.equal(stopResponse.ok, true);
  releaseHeldFetch();
  releaseHeldFetch = null;
  await delay(2700);
  assert.equal((await send('task:state')).data.status, 'stopped');
});

test('ignores unknown message types', () => {
  const result = listener({ type: 'nope:whatever' }, {}, () => {});
  assert.equal(result, false);
});


test('does not replay a mutation when Chrome loses the action acknowledgement', async () => {
  modelCalls = 0;
  executed.length = 0;
  loseActionResponse = true;
  try {
    const started = await send('task:start', { goal: 'Open the catalogue' });
    assert.equal(started.ok, true);
    const state = await waitForTask();
    assert.equal(state.status, 'error');
    assert.match(state.error.message, /may already have happened/);
    assert.equal(executed.length, 1);
    assert.equal(modelCalls, 1);
  } finally {
    loseActionResponse = false;
  }
});


test('navigation observes the new top-level document before the next model turn', async () => {
  const original = tab.url;
  const destination = 'https://shop.example.com/collection';
  firstModelAction = { type: 'navigate', url: destination };
  modelCalls = 0;
  fetchCalls.length = 0;
  try {
    const started = await send('task:start', { goal: 'Read the collection' });
    assert.equal(started.ok, true);
    const state = await waitForTask();
    assert.equal(state.status, 'done');
    assert.equal(state.steps[0].ok, true);
    assert.match(fetchCalls[1].body.messages[1].content, /URL: https:\/\/shop\.example\.com\/collection/);
  } finally {
    tab.url = original;
    firstModelAction = { type: 'click', elementId: 1 };
  }
});
