/**
 * Model picker for the provider editor.
 *
 * The editor can call `GET /models`, but a useful picker needs more than raw
 * ids: a friendly name when the provider supplies one, an instant filter for
 * large catalogues, a cache so reopening is fast, and an explanation in place
 * when discovery fails.
 *
 * This module owns that flow and intercepts clicks on the editor's existing
 * #fetchModelsBtn in the capture phase, so the simpler built-in handler never
 * starts a second, competing request. Choosing a model writes #fModel and
 * dispatches `input`, which lets the editor's own autosave persist the change.
 */

const MODEL_CACHE_LIMIT = 8;

const cache = new Map();
let loading = false;

const $ = (selector) => document.querySelector(selector);

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
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

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || 'this endpoint';
  }
}

function originFor(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

function readValue(id) {
  const field = $(`#${id}`);
  return field && typeof field.value === 'string' ? field.value.trim() : '';
}

function readJson(id) {
  const text = readValue(id);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** The provider fields the worker needs to build a models request. */
function readProvider() {
  return {
    name: readValue('fName') || 'Model discovery',
    baseUrl: readValue('fBaseUrl'),
    apiKey: readValue('fApiKey'),
    model: readValue('fModel'),
    endpointPath: readValue('fEndpointPath'),
    authHeader: readValue('fAuthHeader') || 'Authorization',
    authScheme: readValue('fAuthScheme'),
    params: readJson('fParams'),
    extraHeaders: readJson('fExtraHeaders'),
    useJsonMode: $('#fUseJsonMode')?.checked === true,
    temperature: numberOrNull(readValue('fTemperature')),
    maxTokens: numberOrNull(readValue('fMaxTokens')),
  };
}

async function send(type, payload) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (error) {
    throw new Error(error?.message || 'The background worker did not respond.');
  }
  if (!response) throw new Error('The background worker did not respond.');
  if (!response.ok) {
    const error = new Error(response.error?.message || 'Request failed.');
    error.code = response.error?.code;
    throw error;
  }
  return response.data;
}

function hide() {
  const list = $('#modelList');
  if (!list) return;
  list.hidden = true;
  list.replaceChildren();
}

function linkButton(label, className, title, onClick) {
  return el('button', {
    class: `link-btn ${className}`,
    type: 'button',
    text: label,
    title,
    'aria-label': title,
    onclick: onClick,
  });
}

function nameFor(names, id) {
  if (!names || typeof names !== 'object') return '';
  if (!Object.prototype.hasOwnProperty.call(names, id)) return '';
  return typeof names[id] === 'string' ? names[id] : '';
}

function filterOptions(input, options, count, total) {
  const query = input.value.trim().toLowerCase();
  let shown = 0;
  for (const option of options.children) {
    const matches = !query || option.dataset.search.includes(query);
    option.hidden = !matches;
    if (matches) shown += 1;
  }
  count.textContent = query
    ? `${shown} of ${total} model${total === 1 ? '' : 's'}`
    : `${total} model${total === 1 ? '' : 's'}`;
}

function renderMessage(title, detail, tone = 'info') {
  const list = $('#modelList');
  if (!list) return;
  list.replaceChildren(
    el(
      'div',
      { class: 'model-picker-head' },
      el('span', { class: 'model-count', text: title }),
      el(
        'div',
        { class: 'model-head-actions' },
        linkButton('Close', 'model-close', 'Close the model list', hide),
      ),
    ),
    el('p', { class: 'model-status', dataset: { tone }, text: detail }),
  );
  list.hidden = false;
}

function chooseModel(id) {
  hide();
  const field = $('#fModel');
  if (!field) return;
  field.value = id;
  // The editor autosaves when the field changes; a programmatic assignment
  // does not fire an event, so dispatch it explicitly.
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus({ preventScroll: true });
}

function renderPicker(catalogue, { cached = false, host } = {}) {
  const list = $('#modelList');
  if (!list) return;
  const { models, names, total, truncated } = catalogue;
  const count = el('span', {
    class: 'model-count',
    text: `${models.length} model${models.length === 1 ? '' : 's'}`,
  });
  const head = el(
    'div',
    { class: 'model-picker-head' },
    count,
    el(
      'div',
      { class: 'model-head-actions' },
      cached ? el('span', { class: 'model-cached', text: 'cached' }) : null,
      linkButton('Refresh', 'model-refresh', `Fetch models from ${host} again`, () =>
        void openPicker({ refresh: true }),
      ),
      linkButton('Close', 'model-close', 'Close the model list', hide),
    ),
  );
  const filter = el('input', {
    class: 'model-filter',
    type: 'search',
    placeholder: 'Filter models…',
    'aria-label': 'Filter models',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const options = el('div', {
    class: 'model-options',
    role: 'listbox',
    'aria-label': 'Available models',
  });

  for (const id of models) {
    const name = nameFor(names, id);
    options.append(
      el(
        'button',
        {
          class: 'model-option',
          type: 'button',
          role: 'option',
          title: name ? `${name} — ${id}` : id,
          dataset: { search: `${id} ${name}`.toLowerCase() },
          onclick: () => chooseModel(id),
        },
        el('span', { class: 'model-option-name', text: name || id }),
        name ? el('span', { class: 'model-option-id', text: id }) : null,
      ),
    );
  }

  filter.addEventListener('input', () => filterOptions(filter, options, count, models.length));
  filter.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
      $('#fModel')?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      const first = [...options.children].find((option) => !option.hidden);
      if (first) {
        event.preventDefault();
        first.click();
      }
    }
  });

  list.replaceChildren(head, filter, options);
  if (truncated && Number(total) > models.length) {
    list.append(
      el('p', {
        class: 'model-status',
        text: `Showing the first ${models.length} of ${total} models. Type the id if yours is missing.`,
      }),
    );
  }
  list.hidden = false;
  filter.focus({ preventScroll: true });
}

async function openPicker({ refresh = false } = {}) {
  if (loading) return;
  const provider = readProvider();
  if (!provider.baseUrl) {
    renderMessage('Add a base URL', 'Enter the endpoint base URL, then fetch models again.', 'error');
    $('#fBaseUrl')?.focus();
    return;
  }
  const origin = originFor(provider.baseUrl);
  if (!origin) {
    renderMessage('Invalid base URL', 'Use an http:// or https:// endpoint, then try again.', 'error');
    return;
  }

  const cacheKey = `${provider.baseUrl}|${provider.endpointPath}`;
  if (!refresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      renderPicker(cached, { cached: true, host: hostOf(provider.baseUrl) });
      return;
    }
  }

  const button = $('#fetchModelsBtn');
  const label = button ? button.textContent : '';
  loading = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Loading…';
  }
  renderMessage(
    `Fetching models from ${hostOf(provider.baseUrl)}…`,
    'Chrome may ask for access to this host first.',
  );

  // Chrome only grants optional host permissions while the click's user
  // gesture is active, so start the request before the first await.
  let permission;
  try {
    permission = chrome.permissions?.request
      ? chrome.permissions.request({ origins: [origin] })
      : Promise.reject(
          new Error('Chrome endpoint permission support is unavailable. Reload the extension and try again.'),
        );
  } catch (error) {
    permission = Promise.reject(error);
  }

  try {
    const granted = await permission;
    if (!granted) {
      throw new Error(`Permission to contact ${hostOf(provider.baseUrl)} was not granted.`);
    }
    const data = await send('providers:models', { provider });
    const models = (Array.isArray(data.models) ? data.models : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim());
    if (!models.length) {
      renderMessage(
        'No models returned',
        'This endpoint did not list any models. Type the model id manually — the exact id is in the provider dashboard.',
      );
      return;
    }
    const catalogue = {
      models,
      names: data.names && typeof data.names === 'object' ? data.names : {},
      total: Number.isFinite(data.total) ? data.total : models.length,
      truncated: data.truncated === true,
    };
    cache.set(cacheKey, catalogue);
    if (cache.size > MODEL_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    renderPicker(catalogue, { host: hostOf(provider.baseUrl) });
  } catch (error) {
    renderMessage(
      'Models unavailable',
      `${error?.message || 'Model discovery failed.'} You can still type the model id manually.`,
      'error',
    );
  } finally {
    loading = false;
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

const STYLE_ID = 'fta-model-picker-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#modelList {
  display: block;
  max-height: none;
  overflow: hidden;
  padding: 0;
  gap: 0;
  border: 1px solid var(--border, #2a2d37);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-soft, #14161d);
}
#modelList[hidden] { display: none !important; }
#modelList .model-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border, #2a2d37);
  background: var(--surface-2, #1a1d26);
}
#modelList .model-count {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-2, #aab0c0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#modelList .model-head-actions { display: flex; align-items: center; gap: 10px; flex: none; }
#modelList .model-cached {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-3, #7c8496);
}
#modelList .model-filter {
  display: block;
  width: 100%;
  box-sizing: border-box;
  border: 0;
  border-bottom: 1px solid var(--border, #2a2d37);
  border-radius: 0;
  background: transparent;
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text, #e8eaf0);
  outline: none;
}
#modelList .model-filter::placeholder { color: var(--text-3, #7c8496); }
#modelList .model-options {
  max-height: 168px;
  overflow-y: auto;
  padding: 3px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
#modelList .model-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  width: 100%;
  border: 0;
  background: none;
  text-align: left;
  padding: 5px 7px;
  border-radius: 6px;
  cursor: pointer;
}
#modelList .model-option:hover,
#modelList .model-option:focus-visible { background: var(--surface-3, #242835); }
#modelList .model-option-name {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text, #e8eaf0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
#modelList .model-option-id {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10px;
  color: var(--text-3, #7c8496);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
#modelList .model-status {
  margin: 0;
  padding: 8px 9px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-2, #aab0c0);
}
#modelList .model-status[data-tone="error"] { color: var(--danger, #ff6b6b); }
`;
  document.head.append(style);
}

function interceptFetchButton() {
  ensureStyles();
  document.addEventListener(
    'click',
    (event) => {
      const target =
        typeof event.target?.closest === 'function'
          ? event.target.closest('#fetchModelsBtn')
          : null;
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void openPicker();
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    const list = $('#modelList');
    if (event.key === 'Escape' && list && !list.hidden) {
      hide();
      $('#fModel')?.focus({ preventScroll: true });
    }
  });
}

interceptFetchButton();
