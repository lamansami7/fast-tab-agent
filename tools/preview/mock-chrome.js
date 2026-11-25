/**
 * Mock chrome.* API for the popup UI preview (tools/preview/server.mjs).
 *
 * This file is NOT part of the extension. It lets the real popup run in an
 * ordinary browser tab with canned providers, tabs and a scripted task, so the
 * interface can be reviewed without loading the unpacked extension.
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
      apiKey: 'preview-only-placeholder',
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
    theme: 'auto',
  };

  const tabs = [
    {
      id: 1,
      windowId: 1,
      index: 0,
      title: 'Running shoes — demo store',
      url: 'https://demo-store.example/running-shoes',
      active: true,
      pinned: false,
      supported: true,
      restricted: false,
      reason: '',
      permission: 'granted',
      favIconUrl: '',
    },
    {
      id: 2,
      windowId: 1,
      index: 1,
      title: 'Artificial intelligence — Wikipedia',
      url: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
      active: false,
      pinned: false,
      supported: true,
      restricted: false,
      reason: '',
      permission: 'needed',
      favIconUrl: '',
    },
    {
      id: 3,
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
  ];

  const grantedOrigins = new Set(['https://api.groq.com/*']);
  let tabsPermission = true;
  const listeners = [];
  const storage = {};
  let counter = 0;
  let task = null;
  let timers = [];

  const cloneStorageValue = (value) => (value === undefined ? undefined : clone(value));
  const localArea = {
    async get(keys) {
      if (!keys) return clone(storage);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in storage) out[key] = cloneStorageValue(storage[key]);
      return out;
    },
    async set(items) {
      Object.assign(storage, clone(items));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
    },
  };

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

  function emitProgress() {
    if (!task) return;
    for (const listener of listeners) {
      try {
        listener({ type: 'fta:progress', task: clone(task) });
      } catch {
        /* ignore listener errors */
      }
    }
  }

  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers = [];
  }

  function tabsForPicker() {
    return tabs.map((tab) => ({
      ...clone(tab),
      permission: tab.restricted
        ? 'unavailable'
        : tab.active
          ? 'granted'
          : tab.url
            ? grantedOrigins.has(`${new URL(tab.url).protocol}//${new URL(tab.url).hostname}/*`)
              ? 'granted'
              : 'needed'
            : 'unknown',
    }));
  }

  function startTask(goal, tabId) {
    clearTimers();
    const target = tabs.find((tab) => tab.id === tabId) || tabs[0];
    task = {
      id: `task_${Date.now().toString(36)}`,
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
      provider: {
        id: activeId,
        name: currentProvider()?.name || 'Provider',
        model: currentProvider()?.model || '',
      },
      tabId: target.id,
      tabTitle: target.title,
      tabHost: new URL(target.url).hostname,
      currentStep: 0,
      currentAction: null,
      currentActionLabel: '',
    };
    emitProgress();

    const script = [
      { at: 300, phase: 'reading' },
      { at: 900, phase: 'thinking', currentStep: 1 },
      { at: 1400, phase: 'acting', action: { type: 'type' } },
      {
        at: 2100,
        step: {
          step: 1,
          thought: 'Search for the item the user asked about',
          description: 'type "running shoes" into #4',
          ok: true,
          observation: 'Typed “running shoes” and pressed Enter.',
        },
      },
      { at: 2600, phase: 'thinking', currentStep: 2 },
      { at: 3000, phase: 'acting', action: { type: 'click' } },
      {
        at: 3800,
        step: {
          step: 2,
          thought: 'Compare the results that are in view',
          description: 'click #12',
          ok: true,
          observation: 'Six results between $59 and $189; three are available in size 10.',
        },
      },
      { at: 4300, phase: 'finishing' },
      {
        at: 4800,
        finish: {
          answer:
            'The cheapest size 10 pair is the **Trail Runner 3** at $59, available in blue and grey.\n\nThe next closest option is the “Street Pace 2” at $74. Both show free delivery and returns within 30 days.',
          step: {
            step: 3,
            thought: 'The goal is met with a clear answer',
            description: 'finish',
            ok: true,
            done: true,
            observation: 'Summarised the cheapest matching pair.',
          },
        },
      },
    ];

    for (const entry of script) {
      timers.push(
        setTimeout(() => {
          if (!task || task.status !== 'running') return;
          if (entry.phase) task.phase = entry.phase;
          if (entry.action) {
            task.phase = 'acting';
            task.currentAction = entry.action;
          }
          if (entry.currentStep) task.currentStep = entry.currentStep;
          if (entry.step) {
            task.steps.push(entry.step);
            task.currentAction = null;
            task.phase = 'acting';
          }
          if (entry.finish) {
            task.steps.push(entry.finish.step);
            task.status = 'done';
            task.phase = 'done';
            task.finishedAt = Date.now();
            task.answer = entry.finish.answer;
            task.currentAction = null;
          }
          emitProgress();
        }, entry.at),
      );
    }

    return clone(task);
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

    'app:info': () => {
      const active = tabs.find((tab) => tab.active) || tabs[0];
      return {
        version: '1.1.0 (preview)',
        settings: clone(settings),
        task: task ? clone(task) : null,
        tab: {
          ...clone(active),
          host: new URL(active.url).host,
          permission: 'granted',
          active: true,
        },
      };
    },

    'tabs:list': () => ({
      tabs: tabsForPicker(),
      activeTabId: 1,
      total: tabs.length,
      truncated: false,
      hasTabsPermission: tabsPermission,
      canRequestTabs: true,
    }),

    'task:start': ({ goal, tabId }) => startTask(goal, tabId),
    'task:stop': () => {
      clearTimers();
      if (task && task.status === 'running') {
        task.status = 'stopped';
        task.phase = 'stopped';
        task.finishedAt = Date.now();
        task.answer = 'Stopped before the goal was reached.';
        task.currentAction = null;
        emitProgress();
      }
      return { task: task ? clone(task) : null };
    },
    'task:state': () => (task ? clone(task) : null),
  };

  window.chrome = {
    storage: { local: localArea },
    permissions: {
      contains: async ({ origins, permissions } = {}) => {
        if (Array.isArray(permissions) && permissions.includes('tabs')) return tabsPermission;
        const list = Array.isArray(origins) ? origins : [];
        return list.every((origin) => grantedOrigins.has(origin));
      },
      request: async ({ origins, permissions } = {}) => {
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
      id: 'fta-preview',
      sendMessage: async (message) => {
        await delay(25);
        const handler = handlers[message.type];
        if (!handler) {
          return { ok: false, error: { message: `No preview handler for ${message.type}` } };
        }
        try {
          return { ok: true, data: clone(await handler(message)) };
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
      getManifest: () => ({ version: '1.1.0' }),
    },
  };
})();
