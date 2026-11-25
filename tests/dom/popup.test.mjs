/**
 * Popup UI test in a real DOM (jsdom): initial render, provider management,
 * autosave, connection testing, key handling, deletion and the run timeline.
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

  test('popup: full provider + task flow', async () => {
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
    globalThis.requestAnimationFrame =
      dom.window.requestAnimationFrame?.bind(dom.window) ?? ((cb) => setTimeout(cb, 0));

    // ---------------------------------------------------------- fake API --
    let seq = 0;
    const providers = [
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
    let activeId = 'p_seed000000000001';
    const settings = { maxSteps: 8, showHud: true, jsonMode: false, allowPrivateHttp: false };

    const handlers = {
      'providers:list': () => ({ providers: structuredClone(providers), activeId }),
      'providers:save': ({ provider }) => {
        const record = structuredClone(provider);
        if (!record.id || !/^p_[a-z0-9]{8,32}$/.test(record.id)) {
          record.id = `p_gen${String(++seq).padStart(10, '0')}`;
        }
        const index = providers.findIndex((item) => item.id === record.id);
        if (index >= 0) providers[index] = record;
        else providers.push(record);
        if (!activeId) activeId = record.id;
        return { provider: structuredClone(record), activeId, created: index < 0 };
      },
      'providers:delete': ({ id }) => {
        const index = providers.findIndex((item) => item.id === id);
        if (index >= 0) providers.splice(index, 1);
        if (activeId === id) activeId = providers[0]?.id ?? null;
        return { removed: index >= 0, activeId };
      },
      'providers:activate': ({ id }) => {
        activeId = id;
        return { activeId: id };
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
      'settings:get': () => ({ settings }),
      'settings:save': ({ settings: patch }) => {
        Object.assign(settings, patch);
        return { settings };
      },
      'app:info': () => ({
        version: '1.0.0',
        settings,
        task: null,
        tab: { id: 1, title: 'Example', url: 'https://example.com/', supported: true },
      }),
      'task:state': () => null,
      'task:start': ({ goal }) => ({
        id: 'task_1',
        goal,
        status: 'running',
        phase: 'thinking',
        steps: [],
        startedAt: Date.now(),
        finishedAt: null,
        answer: '',
        error: null,
        maxSteps: 8,
        limitReached: false,
        provider: { id: activeId, name: 'Groq', model: 'llama-3.3-70b-versatile' },
        tabId: 1,
      }),
      'task:stop': () => ({ task: null }),
    };

    const listeners = [];
    const grantedOrigins = new Set(['https://api.groq.com/*']);
    const requestedOrigins = [];
    globalThis.chrome = {
      permissions: {
        contains: async ({ origins }) => origins.every((origin) => grantedOrigins.has(origin)),
        request: async ({ origins }) => {
          requestedOrigins.push(...origins);
          origins.forEach((origin) => grantedOrigins.add(origin));
          return true;
        },
        remove: async ({ origins }) => {
          const hadPermission = origins.some((origin) => grantedOrigins.has(origin));
          origins.forEach((origin) => grantedOrigins.delete(origin));
          return hadPermission;
        },
      },
      runtime: {
        id: 'test',
        sendMessage: async (message) => {
          const handler = handlers[message.type];
          await delay(2);
          if (!handler) return { ok: false, error: { message: `No handler for ${message.type}` } };
          try {
            return { ok: true, data: await handler(message) };
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
    await delay(120);

    const $ = (selector) => document.querySelector(selector);
    const visible = (node) => Boolean(node) && !node.hidden;
    const fire = (node, type = 'input') =>
      node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

    // 1. initial render
    assert.equal($('#chipLabel').textContent, 'Groq');
    assert.equal($('#chipDot').dataset.state, 'ready');
    assert.equal($('#providerList').children.length, 1);
    assert.ok(visible($('#viewMain')));
    assert.ok(!visible($('#viewProviders')));

    // 2. providers panel
    $('#providerChip').click();
    assert.ok(visible($('#viewProviders')));
    assert.ok(!visible($('#viewMain')));

    // 3. preset -> editor
    $('#addProviderBtn').click();
    assert.ok(visible($('#viewNew')));
    assert.equal($('#presetGrid').children.length, 9);
    const addOpenAI = [...$('#presetGrid').querySelectorAll('button.preset')].find(
      (button) => button.getAttribute('aria-label') === 'Add OpenAI',
    );
    addOpenAI.click();
    assert.ok(visible($('#viewEditor')));
    assert.equal($('#fBaseUrl').value, 'https://api.openai.com/v1');
    assert.equal($('#fModel').value, 'gpt-4o-mini');
    assert.equal($('#saveStateText').textContent, 'Not saved yet');
    assert.match($('#endpointPreview').textContent, /api\.openai\.com\/v1\/chat\/completions/);
    assert.ok($('#customWarning').hidden, 'known preset hosts do not show a trust warning');

    // 4. autosave model + key
    $('#fModel').value = 'gpt-4.1-mini';
    fire($('#fModel'));
    assert.equal($('#saveState').dataset.state, 'dirty');
    await delay(900);
    assert.equal(providers.length, 2);
    assert.equal(providers[1].model, 'gpt-4.1-mini');
    assert.equal($('#saveState').dataset.state, 'saved');
    assert.match($('#saveStateText').textContent, /Saved/);

    $('#fApiKey').value = 'sk-test-key-123456';
    fire($('#fApiKey'));
    await delay(900);
    assert.equal(providers[1].apiKey, 'sk-test-key-123456');
    assert.equal($('#fApiKey').type, 'password');
    $('#toggleKey').click();
    assert.equal($('#fApiKey').type, 'text');
    assert.equal($('#toggleKey').getAttribute('aria-pressed'), 'true');
    $('#toggleKey').click();
    assert.equal($('#fApiKey').type, 'password');

    // 5. test connection
    $('#testBtn').click();
    assert.equal($('#testResult').hidden, false);
    await delay(80);
    assert.match($('#testResult').textContent, /Connection successful/);
    assert.equal($('#testResult').dataset.tone, 'success');
    assert.match($('#testResult').textContent, /412 ms/);
    assert.deepEqual(requestedOrigins, ['https://api.openai.com/*']);

    // 6. advanced + optional model discovery
    assert.ok($('#advancedBody').hidden);
    $('#advancedToggle').click();
    assert.equal($('#advancedBody').hidden, false);
    assert.equal($('#advancedToggle').getAttribute('aria-expanded'), 'true');
    $('#fetchModelsBtn').click();
    await delay(80);
    assert.equal($('#modelList').hidden, false);
    assert.equal($('#modelList').children.length, 2);
    $('#modelList').querySelector('button').click();
    assert.equal($('#fModel').value, 'alpha-model');
    assert.equal($('#modelList').hidden, true);

    // 7. invalid endpoints are explained and never saved
    $('#fBaseUrl').value = 'http://api.example.com/v1';
    fire($('#fBaseUrl'));
    assert.equal($('#errBaseUrl').hidden, false);
    assert.match($('#errBaseUrl').textContent, /https/i);
    await delay(900);
    assert.equal(providers[1].baseUrl, 'https://api.openai.com/v1');

    $('#fBaseUrl').value = 'file:///etc/passwd';
    fire($('#fBaseUrl'));
    assert.match($('#errBaseUrl').textContent, /Unsupported URL scheme/i);

    $('#fBaseUrl').value = 'https://api.openai.com/v1';
    fire($('#fBaseUrl'));
    await delay(900);
    assert.equal($('#errBaseUrl').hidden, true);

    // 8. activate from the editor
    $('#activateBtn').click();
    await delay(120);
    assert.equal(activeId, providers[1].id);
    assert.equal($('#activateBtn').textContent, 'Active provider');
    assert.equal($('#editorActivePill').hidden, false);

    // 9. keys survive switching providers
    $('#editorBack').click();
    await delay(80);
    assert.ok(visible($('#viewProviders')));
    assert.equal($('#providerList').children.length, 2);
    const rows = [...$('#providerList').querySelectorAll('.provider-row')];
    assert.equal(rows.filter((row) => row.dataset.active === 'true').length, 1);
    rows.find((row) => row.textContent.includes('Groq')).querySelector('.row-open').click();
    await delay(60);
    assert.equal($('#fApiKey').value, 'gsk_seed');
    $('#editorBack').click();
    await delay(60);
    [...$('#providerList').querySelectorAll('.provider-row')]
      .find((row) => row.textContent.includes('OpenAI'))
      .querySelector('.row-open')
      .click();
    await delay(60);
    assert.equal($('#fApiKey').value, 'sk-test-key-123456');

    // 10. delete needs confirmation
    $('#deleteBtn').click();
    assert.equal($('#deleteConfirm').hidden, false);
    $('#deleteCancel').click();
    assert.equal($('#deleteConfirm').hidden, true);
    $('#deleteBtn').click();
    $('#deleteConfirmBtn').click();
    await delay(120);
    assert.equal(providers.length, 1);
    assert.ok(visible($('#viewProviders')));
    assert.equal($('#chipLabel').textContent, 'Groq');

    // 11. custom provider warns about the endpoint
    $('#addProviderBtn').click();
    $('#customProviderBtn').click();
    assert.ok(visible($('#viewEditor')));
    assert.equal($('#customWarning').hidden, false);
    $('#fBaseUrl').value = 'https://my-proxy.example.net/v1';
    fire($('#fBaseUrl'));
    assert.match($('#customWarningText').textContent, /my-proxy\.example\.net/);
    $('#fName').value = 'My proxy';
    fire($('#fName'));
    $('#fModel').value = 'my-model';
    fire($('#fModel'));
    await delay(900);
    assert.equal(providers.length, 2);
    assert.equal(providers[1].type, 'custom');
    $('#editorBack').click();
    await delay(60);
    assert.equal($('#providerList').children.length, 2);

    // 12. preferences
    $('#prefs').open = true;
    $('#prefShowHud').checked = false;
    fire($('#prefShowHud'), 'change');
    await delay(80);
    assert.equal(settings.showHud, false);

    // 13. run a task and render progress
    $('#providersDone').click();
    $('#goalInput').value = 'Add the cheapest shoes to the cart';
    $('#runBtn').click();
    await delay(100);
    assert.ok(visible($('#runSection')));
    assert.equal($('#runStatus').textContent, 'Working');
    assert.equal($('#runStatus').dataset.state, 'running');
    assert.equal($('#runBtn').hidden, true);
    assert.equal($('#stopBtn').hidden, false);
    assert.match($('#runMeta').textContent, /llama-3\.3-70b-versatile/);

    const emit = (task) => listeners.forEach((fn) => fn({ type: 'fta:progress', task }));

    emit({
      id: 'task_1',
      goal: 'Add the cheapest shoes to the cart',
      status: 'running',
      steps: [
        {
          step: 1,
          thought: 'Search for shoes',
          description: 'type "shoes" into #2',
          ok: true,
          observation: 'Typed shoes',
        },
      ],
      maxSteps: 8,
      provider: { model: 'llama-3.3-70b-versatile' },
    });
    await delay(30);
    assert.equal($('#timeline').children.length, 1);
    assert.match($('#timeline').textContent, /Search for shoes/);

    emit({
      id: 'task_1',
      goal: 'Add the cheapest shoes to the cart',
      status: 'done',
      steps: [
        { step: 1, thought: 'Search', description: 'type "shoes" into #2', ok: true, observation: 'Typed' },
        { step: 2, thought: 'Done', description: 'finish', ok: true, done: true, observation: 'Added to cart.' },
      ],
      answer: 'Added the cheapest pair to your cart.',
      maxSteps: 8,
      provider: { model: 'llama-3.3-70b-versatile' },
    });
    await delay(30);
    assert.equal($('#runStatus').textContent, 'Complete');
    assert.equal($('#runStatus').dataset.state, 'done');
    assert.match($('#runAnswer').textContent, /cheapest pair/);
    assert.equal($('#runBtn').hidden, false);
    assert.equal($('#stopBtn').hidden, true);

    assert.deepEqual(errors, [], `unexpected runtime errors: ${errors.map(String).join(', ')}`);
  });
}
