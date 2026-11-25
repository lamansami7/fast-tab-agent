/** Small in-memory stand-in for chrome.storage.local. */
export function createStorageArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
    },
    async clear() {
      for (const key of Object.keys(data)) delete data[key];
    },
    dump() {
      return structuredClone(data);
    },
  };
}

/** Fake fetch that records calls and delegates to a handler. */
export function createFetchMock(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const parsedBody = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body: parsedBody });
    return handler({ url, initiative: init, body: parsedBody, callIndex: calls.length - 1, calls });
  };
  fn.calls = calls;
  return fn;
}

export function jsonResponse({ status = 200, body, headers = {}, url = '' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        for (const [header, value] of Object.entries(headers)) {
          if (header.toLowerCase() === key) return value;
        }
        return null;
      },
    },
    async text() {
      return text;
    },
  };
}

export function makeProvider(overrides = {}) {
  return {
    id: 'p_abcdefgh12345678',
    name: 'Test Provider',
    type: 'custom',
    presetId: null,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-secret-key-123456',
    model: 'test-model',
    endpointPath: '',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    extraHeaders: {},
    params: {},
    useJsonMode: false,
    temperature: null,
    maxTokens: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

export function makeSnapshot() {
  return {
    url: 'https://shop.example.com/cart',
    title: 'Cart',
    scroll: { y: 0, height: 1200, viewport: 800 },
    elements: [
      { id: 1, tag: 'button', label: 'Sign in', inViewport: true },
      { id: 2, tag: 'input', type: 'search', label: 'Search', inViewport: true },
      { id: 3, tag: 'a', label: 'Checkout', href: '/checkout', inViewport: false },
    ],
    headings: ['Your cart'],
    text: 'Your cart is empty. Continue shopping.',
    iframes: [],
    truncatedElements: 0,
  };
}
