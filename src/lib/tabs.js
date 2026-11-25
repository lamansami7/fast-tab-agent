/**
 * Tab URL classification and tab permission helpers.
 *
 * Chrome exposes every open tab through `chrome.tabs`, but it only reveals a
 * tab's title and URL when the extension has the optional `tabs` permission or
 * host access to that tab. Page content is a separate step: it is only read
 * after the user selects a tab and grants access.
 *
 * Everything in this module is pure so the classification rules can be tested
 * without a browser. The background worker and the popup both use them, which
 * keeps the "why can't the agent read this tab?" story consistent.
 */

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

const RESTRICTED_SCHEME_MESSAGES = {
  'chrome:': 'Chrome internal pages (chrome://) cannot be read or controlled by extensions.',
  'chrome-extension:': 'Other extensions’ pages cannot be read or controlled by this extension.',
  'edge:': 'Browser internal pages cannot be read or controlled by extensions.',
  'about:': 'This browser page cannot be read or controlled by extensions.',
  'devtools:': 'DevTools pages cannot be read or controlled by extensions.',
  'view-source:': 'View-source pages cannot be read or controlled by extensions.',
  'data:': 'Data URLs cannot be read or controlled by extensions.',
  'blob:': 'Blob URLs cannot be used as agent tabs.',
  'javascript:': 'JavaScript URLs are never opened by the agent.',
  'ftp:': 'Only http:// and https:// pages can be used by the agent.',
};

/**
 * Is this a normal web page URL the agent may work with?
 * @param {unknown} raw
 */
export function isHttpUrl(raw) {
  if (typeof raw !== 'string') return false;
  try {
    return HTTP_PROTOCOLS.has(new URL(raw.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * Classify a tab URL for the agent.
 *
 * @param {unknown} raw
 * @returns {{supported:boolean, code:string, reason:string}}
 */
export function classifyTabUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return {
      supported: false,
      code: 'no_url',
      reason: 'This tab has no loaded page yet. Open a website and try again.',
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return {
      supported: false,
      code: 'malformed',
      reason: 'This tab’s address could not be read. Reload the page and try again.',
    };
  }

  if (HTTP_PROTOCOLS.has(url.protocol)) {
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'chromewebstore.google.com' ||
      (hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))
    ) {
      return {
        supported: false,
        code: 'web_store',
        reason: 'The Chrome Web Store does not allow extensions to read or control its pages.',
      };
    }
    if (/\.pdf$/i.test(url.pathname)) {
      return {
        supported: false,
        code: 'pdf',
        reason:
          'Chrome’s PDF viewer cannot be read by extensions. Open the content as a normal web page and try again.',
      };
    }
    return { supported: true, code: 'ok', reason: '' };
  }

  if (url.protocol === 'file:') {
    return {
      supported: false,
      code: 'file',
      reason:
        'Local file pages need “Allow access to file URLs” in the extension details before the agent can use them.',
    };
  }

  return {
    supported: false,
    code: 'restricted_scheme',
    reason:
      RESTRICTED_SCHEME_MESSAGES[url.protocol] ||
      `Chrome does not allow extensions to read ${url.protocol.replace(':', '')} pages.`,
  };
}

/**
 * Narrowest Chrome origin pattern (scheme + host) for a page URL.
 * Returns null for URLs Chrome host permissions cannot cover.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function originPatternFor(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (!HTTP_PROTOCOLS.has(url.protocol) || !url.hostname) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

/** Host (and port) for display. Never includes credentials or the path. */
export function tabHost(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return new URL(raw.trim()).host;
  } catch {
    return '';
  }
}

/** Human title for a tab, with a neutral fallback. */
export function tabTitleFor(tab) {
  const title = typeof tab?.title === 'string' ? tab.title.trim() : '';
  return title || 'Untitled tab';
}

/**
 * Filter the tab picker list. Case-insensitive match on title and host.
 * @param {Array<{title?:string,url?:string}>} tabs
 * @param {string} query
 */
export function filterTabs(tabs, query) {
  const list = Array.isArray(tabs) ? tabs : [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) return list;
  return list.filter((tab) => {
    const haystack = `${tab?.title || ''} ${tabHost(tab?.url)} ${tab?.url || ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/**
 * Pick the default tab for the composer.
 *
 * Prefer the active tab when it is a normal page. Opening the side panel while
 * chrome://extensions (or another browser page) is active must not leave the
 * agent pointing at a page it can never read, so fall back to the first usable
 * website tab instead.
 */
export function chooseInitialTabId(tabs, activeTabId = null) {
  const list = Array.isArray(tabs) ? tabs : [];
  const usable = (tab) => Boolean(tab) && tab.supported !== false && tab.restricted !== true;
  const active = list.find((tab) => tab.id === activeTabId);
  if (usable(active)) return active.id;
  const fallback = list.find((tab) => usable(tab) && tab.url);
  if (fallback) return fallback.id;
  const anyUsable = list.find(usable);
  if (anyUsable) return anyUsable.id;
  if (active) return active.id;
  return list[0]?.id ?? null;
}

/** Keep the active tab first, then the current selection, then browser order. */
export function sortTabsForPicker(tabs, { activeTabId = null, selectedTabId = null } = {}) {
  const rank = (tab) => {
    if (tab?.id === selectedTabId) return 0;
    if (tab?.id === activeTabId) return 1;
    return 2;
  };
  return [...(Array.isArray(tabs) ? tabs : [])].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return (a?.index ?? 0) - (b?.index ?? 0);
  });
}
