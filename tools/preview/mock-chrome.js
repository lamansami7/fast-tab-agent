/**
 * Mock chrome.* API for the popup UI preview (tools/preview/server.mjs).
 *
 * This file is NOT part of the extension. It lets the real popup run in an
 * ordinary browser tab with canned providers and a scripted task, so the UI can
 * be reviewed without loading the unpacked extension.
 */
(function () {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));

  const providers = [
    {
      id: 'p_previewgroq0001',
      name: 'Groq',
      type: 'preset',
      presetId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_preview_key_0001',
      model: 'llama-3.3-70b-versatile',
      endpointPath: '',
      authHeader: 'Authorization',
      authScheme: 'Bearer',
      extraHeaders: {},
      params: {},
      useJsonMode: false,
      temperature: null,
      maxTokens: null,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 3600000,
    },
    {
      id: 'p_previewopenai001',
      name: 'OpenAI (work)',
      type: 'preset',
      presetId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      endpointPath: '',
      authHeader: 'Authorization',
      authScheme: 'Bearer',
      extraHeaders: {},
      params: {},
      useJsonMode: false,
      temperature: null,
      maxTokens: null,
      createdAt: Date.now() - 172800000,
      updatedAt: Date.now() - 172800000,
    },
    {
      id: 'p_previewlocal001',
      name: 'Ollama (local)',
      type: 'preset',
      presetId: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'llama3.2',
      endpointPath: '',
      authHeader: 'Authorization',
      authScheme: 'Bearer',
      extraHeaders: {},
      params: {},
      useJsonMode: false,
      temperature: null,
      maxTokens: null,
      createdAt: Date.now() - 259200000,
      updatedAt: Date.now() - 259200000,
    },
  ];

  let activeId = 'p_previewgroq0001';
  const settings = {
    maxSteps: 8,
    showHud: true,
    jsonMode: false,
    allowPrivateHttp: false,
  };

  let task = null;
  let timers = [];
  const listeners = [];
  let counter = 0;

  const SCRIPT = [
    {
      thought: 'Scanning the page for a search field and product cards',
      description: 'extract from page',
      observation: 'Found a search box, 18 product cards and a cart link.',
      delay: 900,
    },
    {
      thought: 'Search for the item the user asked about',
      description: 'type "running shoes" into #4',
      observation: 'Typed “running shoes” and pressed Enter.',
      delay: 1500,
    },
    {
      thought: 'Compare the results that are in view',
      description: 'scroll down 600px',
      observation: 'Six results between $59 and $189; three are available in size 10.',
      delay: 1600,
    },
    {
      thought: 'Open the cheapest matching pair',
      description: 'click #12',
      observation: 'Clicked “Add to cart”. A confirmation toast appeared.',
      delay: 1500,
    },
    {
      thought: 'The cart shows one item, so the goal is met',
      description: 'finish',
      observation: 'Added the $59 “Trail Runner 3” (size 10) to the cart.',
      done: true,
      delay: 900,
    },
  ];

  function emitProgress() {
    if (!task) return;
    const snapshot = clone(task);
    for (const listener of listeners) {
      try {
        listener({ type: 'fta:progress', task: snapshot });
      } catch {
        /* ignore listener errors */
      }
    }
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers = [];
  }

  function startTask(goal) {
    clearTimers();
    task = {
      id: `task_${Date.now().toString(36)}`,
      goal,
      status: 'running',
      phase: 'thinking',
      steps: [],
      startedAt: Date.now(),
      finishedAt: null,
      answer: '',
      error: null,
      maxSteps: settings.maxSteps,
      limitReached: false,
      provider: { id: activeId, name: currentProvider()?.name || 'Provider', model: currentProvider()?.model || '' },
      tabId: 1,
    };
    emitProgress();

    let elapsed = 0;
    SCRIPT.forEach((step, index) => {
      elapsed += step.delay;
      timers.push(
        setTimeout(() => {
          if (!task || task.status !== 'running') return;
          task.steps.push({
            step: index + 1,
            thought: step.thought,
            description: step.description,
            ok: true,
            done: Boolean(step.done),
            observation: step.observation,
          });
          task.phase = step.done ? 'finishing' : 'acting';
          if (step.done) {
            task.status = 'done';
            task.phase = 'done';
            task.finishedAt = Date.now();
            task.answer = 'Added the cheapest size 10 pair — “Trail Runner 3” at $59 — to your cart.';
          }
          emitProgress();
        }, elapsed),
      );
    });

    return clone(task);
  }

  function currentProvider() {
    return providers.find((provider) => provider.id === activeId) || providers[0] || null;
  }

  function hostOf(provider) {
    try {
      return new URL(provider.baseUrl).host;
    } catch {
      return provider.baseUrl;
    }
  }

  const handlers = {
    'providers:list': () => ({ providers: clone(providers), activeId }),

    'providers:save': ({ provider }) => {
      const record = clone(provider);
      if (!record.id || !/^p_[a-z0-9]{8,32}$/.test(record.id)) {
        record.id = `p_previewgen${String(++counter).padStart(8, '0')}`;
      }
      const index = providers.findIndex((item) => item.id === record.id);
      const created = index < 0;
      if (created) providers.push(record);
      else providers[index] = record;
      if (!activeId) activeId = record.id;
      return { provider: clone(record), activeId, created };
    },

    'providers:delete': ({ id }) => {
      const index = providers.findIndex((provider) => provider.id === id);
      if (index >= 0) providers.splice(index, 1);
      if (activeId === id) activeId = providers[0]?.id ?? null;
      return { removed: index >= 0, activeId };
    },

    'providers:activate': ({ id }) => {
      activeId = id;
      return { activeId: id };
    },

    'providers:test': async ({ provider }) => {
      await delay(750);
      const target = provider || currentProvider();
      const host = hostOf(target);
      const isLocal = /localhost|127\.0\.0\.1/.test(host);
      if (!target?.model) {
        return { status: 'invalid_config', ok: false, message: 'Enter a model id first.', host };
      }
      if (!target?.apiKey && !isLocal) {
        return {
          status: 'invalid_config',
          ok: false,
          message: 'Add your API key for this provider.',
          hint: 'The key is stored locally and sent only to this endpoint.',
          host,
          model: target.model,
        };
      }
      return {
        status: 'success',
        ok: true,
        message: `Connected to ${host}.`,
        reply: 'ok',
        host,
        model: target.model,
        latencyMs: 320 + Math.round(Math.random() * 260),
        httpStatus: 200,
      };
    },

    'providers:models': async ({ provider }) => {
      await delay(600);
      const host = hostOf(provider || currentProvider());
      const catalogue = host.includes('groq')
        ? ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
        : host.includes('openai')
          ? ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini']
          : ['llama3.2', 'qwen2.5:7b', 'mistral:7b'];
      return { models: catalogue };
    },

    'settings:get': () => ({ settings: clone(settings) }),
    'settings:save': ({ settings: patch }) => {
      Object.assign(settings, patch || {});
      return { settings: clone(settings) };
    },

    'task:start': ({ goal }) => startTask(goal),
    'task:stop': () => {
      clearTimers();
      if (task && task.status === 'running') {
        task.status = 'stopped';
        task.phase = 'stopped';
        task.finishedAt = Date.now();
        task.answer = 'Stopped before the goal was reached.';
        emitProgress();
      }
      return { task: clone(task) };
    },
    'task:state': () => (task ? clone(task) : null),

    'app:info': () => ({
      version: '1.0.0 (preview)',
      settings: clone(settings),
      task: task ? clone(task) : null,
      tab: {
        id: 1,
        title: 'Running shoes — demo store',
        url: 'https://demo-store.example/running-shoes',
        supported: true,
      },
    }),
  };

  window.chrome = {
    runtime: {
      id: 'fta-preview',
      sendMessage: async (message) => {
        await delay(30);
        const handler = handlers[message.type];
        if (!handler) {
          return { ok: false, error: { message: `No preview handler for ${message.type}` } };
        }
        try {
          return { ok: true, data: await handler(message) };
        } catch (error) {
          return { ok: false, error: { code: 'preview_error', message: error.message } };
        }
      },
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      getManifest: () => ({ version: '1.0.0' }),
    },
  };
})();
