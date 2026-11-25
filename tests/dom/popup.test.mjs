/**
 * Popup UI test in a real DOM (jsdom): chat rendering, task progress,
 * cancellation, tab picker permissions, settings, themes and the provider
 * editor.
 *
 * Requires the dev dependency: npm install && npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('popup UI (skipped — jsdom is not installed)', { skip: true }, () => {});
}

if (JSDOM) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..', '..');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  // Poll for an observable UI/worker state instead of assuming a fixed amount
  // of wall-clock time is enough. The popup renders synchronously before it
  // sends task:start; on a slow or busy machine that render can outlast any
  // hard-coded delay, which made this test flaky.
  const waitFor = async (predicate, { timeout = 5000, interval = 10 } = {}) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for the popup to reach the expected state.');
      }
      await delay(interval);
    }
  };

  test('popup: chat, tabs, settings and provider flow', async () => {
    const html = await readFile(join(ROOT, 'src/popup/popup.html'), 'utf8');
    const dom = new JSDOM(html, {
      url: 'chrome-extension://test/popup.html',
      pretendToBeVisual: true,
    });

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Node = dom.window.Node;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.Element = dom.window.Element;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.requestAnimationFrame =
      dom.window.requestAnimationFrame?.bind(dom.window) ?? ((cb) => setTimeout(cb, 0));

    // ---------------------------------------------------------- fake state --
    let seq = 0;
    let taskSeq = 0;
    let activeId = 'p_seed000000000001';
    let currentTask = null;
    const started = [];
    const stopCalls = [];
    const requested = [];
    const grantedOrigins = new Set(['https://api.groq.com/*']);
    let tabsPermission = true;
    const providerStore = [
      {
        id: 'p_seed000000000001',
        name: 'Groq',
        type: 'preset',
        presetId: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk_seed',
        model: 'llama-3.3-70b-versatile',
        endpointPath: '',
        authHeader: 'Authorization',
        authScheme: 'Bearer',
        extraHeaders: {},
        params: {},
        useJsonMode: false,
        temperature: null,
        maxTokens: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const settings = {
      maxSteps: 8,
      showHud: true,
      jsonMode: false,
      allowPrivateHttp: false,
      theme: 'auto',
    };

    const tabs = [
      {
        id: 7,
        windowId: 1,
        index: 0,
        title: 'Shop — demo',
        url: 'https://shop.example.com/products',
        active: true,
        pinned: false,
        supported: true,
        restricted: false,
        reason: '',
        permission: 'granted',
        favIconUrl: '',
      },
      {
        id: 8,
        windowId: 1,
        index: 1,
        title: 'Docs',
        url: 'https://docs.example.org/guide',
        active: false,
        pinned: false,
        supported: true,
        restricted: false,
        reason: '',
        permission: 'needed',
        favIconUrl: '',
      },
      {
        id: 9,
        windowId: 1,
        index: 2,
        title: 'Settings',
        url: 'chrome://settings',
        active: false,
        pinned: false,
        supported: false,
        restricted: true,
        reason: 'Chrome internal pages (chrome://) cannot be read or controlled by extensions.',
        permission: 'unavailable',
        favIconUrl: '',
      },
      {
        id: 10,
        windowId: 2,
        index: 0,
        title: 'Other window',
        url: '',
        active: false,
        pinned: false,
        supported: true,
        restricted: false,
        reason: '',
        permission: 'unknown',
        favIconUrl: '',
      },
    ];

    const storageData = {};
    const storage = {
      async get(keys) {
        if (!keys) return clone(storageData);
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const key of list) if (key in storageData) out[key] = clone(storageData[key]);
        return out;
      },
      async set(items) {
        Object.assign(storageData, clone(items));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
      },
    };

    const tabsForPicker = () =>
      tabs.map((tab) => ({
        ...clone(tab),
        permission:
          tab.restricted
            ? 'unavailable'
            : tab.active
              ? 'granted'
              : tab.url
                ? grantedOrigins.has(`${new URL(tab.url).protocol}//${new URL(tab.url).hostname}/*`)
                  ? 'granted'
                  : 'needed'
                : 'unknown',
      }));

    const handlers = {
      'providers:list': () => ({ providers: clone(providerStore), activeId }),
      'providers:save': ({ provider }) => {
        const record = clone(provider);
        if (!record.id || !/^p_[a-z0-9]{8,32}$/.test(record.id)) {
          record.id = `p_gen${String(++seq).padStart(10, '0')}`;
        }
        record.createdAt = record.createdAt || Date.now();
        record.updatedAt = Date.now();
        const index = providerStore.findIndex((item) => item.id === record.id);
        if (index >= 0) providerStore[index] = record;
        else providerStore.push(record);
        if (!activeId) activeId = record.id;
        return { provider: clone(record), activeId, created: index < 0 };
      },
      'providers:delete': ({ id }) => {
        const index = providerStore.findIndex((item) => item.id === id);
        if (index >= 0) providerStore.splice(index, 1);
        if (activeId === id) activeId = providerStore[0]?.id ?? null;
        return { removed: index >= 0, activeId };
      },
      'providers:activate': ({ id }) => {
        activeId = id;
        return { activeId: id, provider: clone(providerStore.find((p) => p.id === id)) };
      },
      'providers:test': ({ provider }) => ({
        status: provider?.apiKey ? 'success' : 'invalid_config',
        ok: Boolean(provider?.apiKey),
        message: provider?.apiKey
          ? 'Connected to api.example.com.'
          : 'Add your API key for this provider.',
        hint: '',
        host: 'api.example.com',
        latencyMs: 412,
        httpStatus: 200,
        model: provider?.model,
      }),
      'providers:models': () => ({ models: ['alpha-model', 'beta-model'] }),
      'settings:save': ({ settings: patch }) => {
        Object.assign(settings, patch);
        return { settings: clone(settings) };
      },
      'settings:get': () => ({ settings: clone(settings) }),
      'app:info': () => ({
        version: '1.1.0 (test)',
        settings: clone(settings),
        task: currentTask ? clone(currentTask) : null,
        tab: clone(tabs[0]),
      }),
      'tabs:list': () => ({
        tabs: tabsForPicker(),
        activeTabId: 7,
        total: tabs.length,
        truncated: false,
        hasTabsPermission: tabsPermission,
        canRequestTabs: true,
      }),
      'task:state': () => (currentTask ? clone(currentTask) : null),
      'task:start': ({ goal, tabId }) => {
        const target = tabs.find((item) => item.id === tabId) || tabs[0];
        currentTask = {
          id: `task_${++taskSeq}`,
          goal,
          status: 'running',
          phase: 'starting',
          steps: [],
          startedAt: Date.now(),
          finishedAt: null,
          answer: '',
          error: null,
          maxSteps: settings.maxSteps,
          limitReached: false,
          provider: { id: activeId, name: 'Groq', model: 'llama-3.3-70b-versatile' },
          tabId: target.id,
          tabTitle: target.title,
          tabHost: new URL(target.url).hostname,
          currentStep: 0,
          currentAction: null,
          currentActionLabel: '',
        };
        started.push({ goal, tabId: target.id });
        return clone(currentTask);
      },
      'task:stop': () => {
        stopCalls.push(Date.now());
        if (currentTask && currentTask.status === 'running') currentTask.phase = 'stopping';
        return { task: currentTask ? clone(currentTask) : null };
      },
    };

    const listeners = [];
    const permissionChecks = [];
    globalThis.chrome = {
      storage: { local: storage },
      permissions: {
        contains: async ({ origins, permissions } = {}) => {
          if (Array.isArray(permissions) && permissions.includes('tabs')) return tabsPermission;
          const list = Array.isArray(origins) ? origins : [];
          permissionChecks.push(...list);
          return list.every((origin) => grantedOrigins.has(origin));
        },
        request: async ({ origins, permissions } = {}) => {
          requested.push({ origins: origins || [], permissions: permissions || [] });
          if (Array.isArray(permissions) && permissions.includes('tabs')) {
            tabsPermission = true;
            return true;
          }
          for (const origin of origins || []) grantedOrigins.add(origin);
          return true;
        },
        remove: async ({ origins } = {}) => {
          let removed = false;
          for (const origin of origins || []) removed = grantedOrigins.delete(origin) || removed;
          return removed;
        },
        getAll: async () => ({
          origins: [...grantedOrigins],
          permissions: tabsPermission ? ['tabs'] : [],
        }),
      },
      runtime: {
        id: 'test',
        sendMessage: async (message) => {
          const handler = handlers[message.type];
          await delay(2);
          if (!handler) return { ok: false, error: { message: `No handler for ${message.type}` } };
          try {
            return { ok: true, data: clone(await handler(message)) };
          } catch (error) {
            return { ok: false, error: { message: error.message } };
          }
        },
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    };

    const errors = [];
    dom.window.addEventListener('error', (event) => errors.push(event.error || event.message));
    process.on('unhandledRejection', (reason) => errors.push(reason));

    await import(join(ROOT, 'src/popup/popup.js'));
    await waitFor(
      () =>
        document.querySelector('#chipLabel')?.textContent === 'Groq' &&
        document.querySelector('#tabCount')?.textContent === '4',
    );

    const $ = (selector) => document.querySelector(selector);
    const visible = (node) => Boolean(node) && !node.hidden;
    const fire = (node, type = 'input') =>
      node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    const key = (node, options) =>
      node.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...options }),
      );
    const emit = (task) => listeners.forEach((listener) => listener({ type: 'fta:progress', task }));
    const findText = (selector, text) =>
      [...document.querySelectorAll(selector)].find((node) => node.textContent.includes(text));

    // 1. initial chat-first render
    assert.ok(visible($('#viewMain')));
    assert.equal($('#chipLabel').textContent, 'Groq');
    assert.equal($('#brandStatus').textContent, 'Ready');
    assert.equal($('#emptyState').hidden, false);
    assert.equal($('#messages').children.length, 0);
    assert.equal($('#tabTitle').textContent, 'Shop — demo');
    assert.equal($('#tabHost').textContent, 'shop.example.com');
    assert.equal($('#tabPermBtn').dataset.state, 'granted');
    assert.equal($('#tabCount').textContent, '4');
    assert.equal($('#runBtn').disabled, true);
    assert.equal($('#goalHint').textContent, '');

    // 2. empty-state suggestions fill the composer without sending
    const suggestion = $('#suggestions .suggestion');
    suggestion.click();
    assert.equal($('#goalInput').value, 'Summarize this page.');
    assert.equal($('#runBtn').disabled, false);
    assert.equal(started.length, 0);
    fire($('#goalInput'));

    // 3. send a request; the optimistic conversation appears immediately
    $('#runBtn').click();
    await waitFor(() => started.length === 1 && $('#stopBtn').hidden === false);
    assert.equal(started.length, 1);
    assert.equal(started[0].tabId, 7);
    assert.equal(started[0].goal, 'Summarize this page.');
    assert.equal($('#emptyState').hidden, true);
    assert.equal($('#messages').children.length, 2);
    assert.match($('#messages').textContent, /Summarize this page\./);
    assert.match($('#messages').textContent, /Getting ready/);
    assert.equal($('#stopBtn').hidden, false);
    assert.equal($('#runBtn').hidden, true);
    assert.equal($('#goalInput').value, '');
    assert.equal($('#runArea'), null); // the old one-shot timeline is gone

    // 4. live phase and action progress
    emit({ ...currentTask, phase: 'reading' });
    await delay(30);
    assert.match($('#messages').textContent, /Reading the page/);

    emit({
      ...currentTask,
      phase: 'acting',
      currentAction: { type: 'click', elementId: 4 },
      steps: [
        { step: 1, description: 'click #4', ok: true, observation: 'Clicked “Search”.' },
      ],
    });
    await delay(30);
    assert.match($('#messages').textContent, /Clicking an element/);
    assert.match($('#messages').textContent, /Clicked “Search”/);
    assert.match($('#messages').textContent, /Activity \(1\)/);

    // 5. completion clears the running state and persists the answer
    currentTask = {
      ...currentTask,
      status: 'done',
      phase: 'done',
      answer: 'This page sells running shoes.\n\nPrices start at $59.',
      steps: [
        {
          step: 1,
          description: 'extract from page',
          ok: true,
          done: true,
          observation: 'Running shoes, $59.',
        },
      ],
    };
    emit(currentTask);
    await delay(80);
    assert.match($('#messages').textContent, /This page sells running shoes\./);
    assert.match($('#messages').textContent, /Prices start at \$59\./);
    assert.equal(
      [...document.querySelectorAll('.status-chip')].at(-1).textContent,
      'Done',
    );
    assert.equal($('#stopBtn').hidden, true);
    assert.equal($('#runBtn').hidden, false);
    const savedChat = storageData['fta.chat'];
    assert.equal(savedChat.messages.length, 2);
    assert.equal(savedChat.messages[1].status, 'done');
    assert.match(savedChat.messages[1].text, /running shoes/);
    assert.equal('apiKey' in savedChat.messages[1], false);

    // 6. provider errors are actionable and marked failed
    $('#goalInput').value = 'Trigger a provider error';
    fire($('#goalInput'));
    $('#runBtn').click();
    await waitFor(() => started.length === 2 && $('#stopBtn').hidden === false);
    currentTask = {
      ...currentTask,
      goal: 'Trigger a provider error',
      status: 'error',
      phase: 'error',
      answer: '',
      error: {
        message: 'The provider returned an empty response.',
        hint: 'Try another model or increase the token limit.',
      },
      steps: [],
    };
    emit(currentTask);
    await delay(60);
    assert.match($('#messages').textContent, /empty response/i);
    assert.match($('#messages').textContent, /Try another model/);
    assert.equal([...document.querySelectorAll('.status-chip')].at(-1).textContent, 'Failed');
    assert.equal($('#stopBtn').hidden, true);

    // 7. cancellation is reflected immediately and settles cleanly
    $('#goalInput').value = 'Stop this request';
    fire($('#goalInput'));
    $('#runBtn').click();
    await waitFor(() => started.length === 3 && $('#stopBtn').hidden === false);
    $('#stopBtn').click();
    await waitFor(() => stopCalls.length === 1);
    assert.equal(stopCalls.length, 1);
    assert.match($('#messages').textContent, /Stopping/);
    currentTask = {
      ...currentTask,
      goal: 'Stop this request',
      status: 'stopped',
      phase: 'stopped',
      answer: 'Stopped before the goal was reached.',
      error: null,
      steps: [],
    };
    emit(currentTask);
    await delay(50);
    assert.equal([...document.querySelectorAll('.status-chip')].at(-1).textContent, 'Stopped');
    assert.match($('#messages').textContent, /Stopped before the goal was reached/);
    assert.equal($('#runBtn').hidden, false);

    // 8. tab picker: list, permission grant, selection
    $('#tabsBtn').click();
    await delay(90);
    assert.ok(visible($('#viewTabs')));
    assert.equal($('#tabList').children.length, 4);
    assert.match($('#tabsSub').textContent, /4 of 4 open tabs/);
    assert.equal($('#tabsPermissionBanner').hidden, true);

    findText('.tab-row', 'Docs').click();
    await waitFor(
      () =>
        visible($('#viewMain')) &&
        $('#tabTitle').textContent === 'Docs' &&
        $('#tabPermBtn').dataset.state === 'granted',
    );
    assert.ok(
      requested.some((entry) => entry.origins.includes('https://docs.example.org/*')),
      'site access was requested for the chosen tab',
    );
    assert.ok(visible($('#viewMain')));
    assert.equal($('#tabTitle').textContent, 'Docs');
    assert.equal($('#tabHost').textContent, 'docs.example.org');
    assert.equal($('#tabPermBtn').dataset.state, 'granted');

    // 9. restricted and hidden tabs explain themselves instead of breaking
    $('#tabsBtn').click();
    await delay(80);
    const restrictedRow = findText('.tab-row', 'Settings');
    assert.equal(restrictedRow.dataset.restricted, 'true');
    restrictedRow.click();
    await delay(40);
    assert.match($('#toast').textContent, /Chrome internal pages/);
    assert.ok(visible($('#viewTabs')), 'the picker stays open after a restricted page');

    findText('.tab-row', 'Other window').click();
    await waitFor(() => /still hides this tab.s address/i.test($('#toast').textContent));
    assert.match($('#toast').textContent, /still hides this tab.s address/i);
    $('#tabsDone').click();
    assert.ok(visible($('#viewMain')));

    // 10. settings: provider panel, behaviour, theme, access list
    $('#settingsBtn').click();
    await delay(90);
    assert.ok(visible($('#viewSettings')));
    assert.equal($('#panelProviders').hidden, false);
    assert.equal($('#providerList').children.length, 1);

    $('#tabBehavior').click();
    await delay(40);
    assert.equal($('#panelBehavior').hidden, false);
    assert.equal($('#panelProviders').hidden, true);

    $('#prefTheme').value = 'dark';
    fire($('#prefTheme'), 'change');
    await waitFor(
      () => settings.theme === 'dark' && document.documentElement.dataset.theme === 'dark',
    );
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(settings.theme, 'dark');

    $('#prefMaxSteps').value = '6';
    fire($('#prefMaxSteps'), 'change');
    await waitFor(() => settings.maxSteps === 6);
    assert.equal(settings.maxSteps, 6);

    await waitFor(() => $('#siteAccessList').children.length >= 2);
    assert.ok($('#siteAccessList').children.length >= 2, 'granted hosts are listed');
    const docsAccess = findText('.access-row', 'docs.example.org');
    assert.ok(docsAccess, 'the selected site is listed');
    docsAccess.querySelector('button').click();
    await waitFor(() => !grantedOrigins.has('https://docs.example.org/*'));
    assert.ok(!grantedOrigins.has('https://docs.example.org/*'));

    // 11. clear conversation with confirmation
    $('#clearChatBtn').click();
    assert.equal($('#clearConfirm').hidden, false);
    $('#clearConfirmBtn').click();
    await waitFor(
      () =>
        $('#messages').children.length === 0 &&
        storageData['fta.chat'] === undefined &&
        $('#chatCount').textContent === 'No messages',
    );
    assert.equal($('#messages').children.length, 0);
    assert.equal($('#emptyState').hidden, false);
    assert.equal(storageData['fta.chat'], undefined);
    assert.equal($('#chatCount').textContent, 'No messages');

    // 12. add, test, activate and delete a provider
    $('#tabAi').click();
    $('#addProviderBtn').click();
    await delay(40);
    assert.ok(visible($('#viewNew')));
    assert.equal($('#presetGrid').children.length, 9);
    const addOpenAI = [...$('#presetGrid').querySelectorAll('button.preset')].find(
      (button) => button.getAttribute('aria-label') === 'Add OpenAI',
    );
    addOpenAI.click();
    await waitFor(
      () =>
        visible($('#viewEditor')) &&
        $('#fBaseUrl').value === 'https://api.openai.com/v1' &&
        $('#fModel').value === 'gpt-4o-mini',
    );
    assert.ok(visible($('#viewEditor')));
    assert.equal($('#fBaseUrl').value, 'https://api.openai.com/v1');
    assert.equal($('#fModel').value, 'gpt-4o-mini');

    $('#fModel').value = 'gpt-4.1-mini';
    fire($('#fModel'));
    await waitFor(
      () =>
        providerStore.length === 2 &&
        providerStore[1].model === 'gpt-4.1-mini' &&
        $('#saveState').dataset.state === 'saved',
    );
    assert.equal(providerStore.length, 2);
    assert.equal(providerStore[1].model, 'gpt-4.1-mini');
    assert.equal($('#saveState').dataset.state, 'saved');

    $('#fApiKey').value = 'sk-test-key-123456';
    fire($('#fApiKey'));
    await waitFor(() => providerStore[1]?.apiKey === 'sk-test-key-123456');
    assert.equal(providerStore[1].apiKey, 'sk-test-key-123456');
    assert.equal($('#fApiKey').type, 'password');
    $('#toggleKey').click();
    assert.equal($('#fApiKey').type, 'text');
    $('#toggleKey').click();
    assert.equal($('#fApiKey').type, 'password');

    $('#testBtn').click();
    await waitFor(() => $('#testResult').dataset.tone === 'success');
    assert.equal($('#testResult').dataset.tone, 'success');
    assert.match($('#testResult').textContent, /Connection successful/);
    assert.ok(
      requested.some((entry) => entry.origins.includes('https://api.openai.com/*')),
      'the endpoint host permission is requested before testing',
    );

    $('#activateBtn').click();
    await waitFor(
      () => activeId === providerStore[1].id && $('#activateBtn').textContent === 'Active provider',
    );
    assert.equal(activeId, providerStore[1].id);
    assert.equal($('#activateBtn').textContent, 'Active provider');

    $('#deleteBtn').click();
    assert.equal($('#deleteConfirm').hidden, false);
    $('#deleteCancel').click();
    assert.equal($('#deleteConfirm').hidden, true);
    $('#deleteBtn').click();
    $('#deleteConfirmBtn').click();
    await waitFor(() => providerStore.length === 1 && visible($('#viewSettings')));
    assert.equal(providerStore.length, 1);
    assert.ok(visible($('#viewSettings')));

    // 13. keyboard behaviour: Shift+Enter does not send, Enter does
    $('#settingsBack').click();
    await delay(40);
    const startCount = started.length;
    $('#goalInput').value = 'Keyboard request';
    fire($('#goalInput'));
    key($('#goalInput'), { key: 'Enter', shiftKey: true });
    await delay(40);
    assert.equal(started.length, startCount, 'Shift+Enter keeps a new line');
    key($('#goalInput'), { key: 'Enter' });
    await waitFor(() => started.length === startCount + 1 && $('#stopBtn').hidden === false);
    assert.equal(started.length, startCount + 1, 'Enter sends');

    emit({
      ...currentTask,
      status: 'done',
      phase: 'done',
      answer: 'Keyboard request finished.',
      error: null,
    });
    await waitFor(() => /Keyboard request finished/.test($('#messages').textContent));
    assert.match($('#messages').textContent, /Keyboard request finished/);

    assert.deepEqual(errors, [], `unexpected runtime errors: ${errors.map(String).join(', ')}`);
  });
}
