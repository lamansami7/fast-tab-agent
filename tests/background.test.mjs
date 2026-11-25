/**
 * End-to-end test of the service worker: message routing, provider CRUD,
 * connection testing and a full agent run against a fake tab + fake API.
 *
 * Node's test runner executes the tests in this file sequentially, so they
 * share one booted worker (just like the real extension).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStorageArea, jsonResponse } from './helpers.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const local = createStorageArea();
const session = createStorageArea();
const runtimeListeners = [];
const broadcasts = [];
const executed = [];
const fetchCalls = [];
let modelCalls = 0;

const tab = { id: 7, status: 'complete', title: 'Shop', url: 'https://shop.example.com/products' };

function contentAgent(message) {
  if (message.type === 'fta:ping') return { ok: true, url: tab.url };
  if (message.type === 'fta:snapshot') {
    return {
      ok: true,
      snapshot: {
        url: tab.url,
        title: tab.title,
        elements: [{ id: 1, tag: 'button', label: 'Search', inViewport: true }],
        headings: [],
        text: 'Products',
        iframes: [],
      },
    };
  }
  if (message.type === 'fta:execute') {
    executed.push(message.action);
    return { ok: true, observation: `Did ${message.action.type}.` };
  }
  if (message.type === 'fta:hud') return { ok: true };
  return { ok: false, error: 'unknown message' };
}

globalThis.chrome = {
  storage: { local, session },
  runtime: {
    onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getManifest: () => ({ version: '1.0.0' }),
    getPlatformInfo: (callback) => callback && callback({}),
    lastError: undefined,
    sendMessage: async (message) => {
      broadcasts.push(JSON.parse(JSON.stringify(message)));
      throw new Error('no receiving popup');
    },
  },
  tabs: {
    query: async () => [tab],
    get: async () => tab,
    sendMessage: async (_tabId, message) => contentAgent(message),
  },
  scripting: { executeScript: async () => {} },
};

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init, body: JSON.parse(init.body) });
  modelCalls += 1;
  const content =
    modelCalls === 1
      ? JSON.stringify({
          thought: 'Click search',
          plan: ['click', 'finish'],
          action: { type: 'click', elementId: 1 },
        })
      : JSON.stringify({ thought: 'All done', done: true, answer: 'Searched the catalogue.' });
  return jsonResponse({
    body: { model: 'test-model', choices: [{ message: { content }, finish_reason: 'stop' }] },
  });
};

await import('../src/background.js');
await delay(80);

const listener = runtimeListeners[0];

function send(type, payload = {}) {
  return new Promise((resolve) => {
    listener({ type, ...payload }, {}, resolve);
    setTimeout(() => resolve(undefined), 4000);
  });
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
  taskId = response.data.id;

  let state = null;
  for (let i = 0; i < 60; i += 1) {
    await delay(50);
    state = (await send('task:state')).data;
    if (state && state.status !== 'running') break;
  }

  assert.equal(state.status, 'done');
  assert.equal(state.answer, 'Searched the catalogue.');
  assert.equal(state.steps.length, 2);
  assert.deepEqual(executed, [{ type: 'click', elementId: 1 }]);
  assert.equal(fetchCalls[0].body.model, 'custom-7b');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer sk-custom-secret-9876');
  assert.match(fetchCalls[0].body.messages[0].content, /autonomous browser agent/i);
  assert.match(fetchCalls[0].body.messages[1].content, /Search for shoes/);
  assert.equal(state.provider.model, 'custom-7b');
  assert.ok(session.dump()['fta.task'], 'task snapshot persisted for a reopened popup');

  const progress = broadcasts.filter((message) => message.type === 'fta:progress');
  assert.ok(progress.length >= 2, 'progress broadcasts emitted');
  assert.equal(progress.at(-1).task.status, 'done');
  assert.equal(
    JSON.stringify(broadcasts).includes('sk-custom-secret-9876'),
    false,
    'API key never appears in progress messages',
  );
  assert.ok(taskId);
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

  response = await send('settings:save', { settings: { maxSteps: 999 } });
  assert.equal(response.data.settings.maxSteps, 20);
});

test('app:info reports the current tab and settings', async () => {
  const response = await send('app:info');
  assert.equal(response.ok, true);
  assert.equal(response.data.tab.url, tab.url);
  assert.equal(response.data.tab.supported, true);
  assert.equal(response.data.version, '1.0.0');
  assert.equal(JSON.stringify(response.data).includes('sk-custom-secret-9876'), false);
});

test('ignores unknown message types', () => {
  const result = listener({ type: 'nope:whatever' }, {}, () => {});
  assert.equal(result, false);
});
