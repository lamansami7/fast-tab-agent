/**
 * Endpoint validation and URL construction.
 *
 * Rules enforced here (see README "Security model"):
 *  - only http: and https: are accepted;
 *  - embedded credentials are rejected;
 *  - https: is required for anything that is not an explicit local endpoint;
 *  - http: is allowed for loopback (localhost, 127.0.0.0/8, ::1) and, when the
 *    user explicitly opts in, for RFC1918 / CGNAT / .local addresses;
 *  - link-local and cloud metadata addresses are always rejected;
 *  - query strings and fragments are rejected on the base URL so the request
 *    destination cannot be quietly re-routed.
 *
 * Every function is pure so it can be unit tested without a browser.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const LINK_LOCAL_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '169.254.169.254',
]);

function parseIPv4(hostname) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return null;
  const parts = m.slice(1).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

export function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (h === '0.0.0.0') return true;
  const v4 = parseIPv4(h);
  if (v4 && v4[0] === 127) return true;
  return false;
}

export function isPrivateHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h === '[::1]' || h === '::1') return true;
  if (h.startsWith('[fd') || h.startsWith('[fc')) return true; // unique local IPv6
  const v4 = parseIPv4(h);
  if (!v4) return false;
  const [a, b] = v4;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (Tailscale etc.)
  return false;
}

export function isLinkLocalHost(hostname) {
  if (!hostname) return false;
  const h = String(hostname).toLowerCase();
  if (LINK_LOCAL_HOSTS.has(h)) return true;
  if (h.startsWith('[fe80') || h.startsWith('[::ffff:169.254')) return true;
  const v4 = parseIPv4(h);
  return Boolean(v4 && v4[0] === 169 && v4[1] === 254);
}

function fail(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    warnings: extra.warnings || [],
    isLocal: Boolean(extra.isLocal),
  };
}

/**
 * Validate and canonicalise a provider base URL.
 *
 * @param {unknown} raw
 * @param {{ allowPrivateHttp?: boolean }} [options]
 * @returns {{ok:true, url:URL, baseUrl:string, host:string, isLocal:boolean, isPrivate:boolean, warnings:string[]}
 *          | {ok:false, code:string, message:string, warnings:string[], isLocal:boolean}}
 */
export function validateBaseUrl(raw, options = {}) {
  const allowPrivateHttp = Boolean(options.allowPrivateHttp);
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (!value) {
    return fail('empty', 'Enter the provider base URL, for example https://api.openai.com/v1.');
  }
  if (value.length > 2048) {
    return fail('too_long', 'That base URL is too long.');
  }
  if (/\s/.test(value)) {
    return fail('malformed', 'The base URL cannot contain spaces.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      return fail('malformed', 'Include the scheme, for example https://api.example.com/v1.');
    }
    return fail('malformed', 'That base URL is not a valid URL.');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    const scheme = url.protocol.replace(':', '');
    return fail(
      'unsupported_scheme',
      `Unsupported URL scheme "${scheme}://". Use https:// (or http:// for a local model server).`,
    );
  }
  if (url.username || url.password) {
    return fail(
      'credentials',
      'Remove the username or password from the URL. Use the API key field instead.',
    );
  }
  if (!url.hostname) {
    return fail('malformed', 'The base URL is missing a hostname.');
  }
  if (url.hash) {
    return fail('malformed', 'Remove the "#" fragment from the base URL.');
  }
  if (url.search) {
    return fail(
      'query',
      'Base URLs cannot include query parameters. Add them as custom request parameters or an endpoint path instead.',
    );
  }

  const hostname = url.hostname.toLowerCase();
  const isLocal = isLoopbackHost(hostname);
  const isPrivate = isPrivateHost(hostname);

  if (isLinkLocalHost(hostname)) {
    return fail(
      'link_local',
      'Link-local and cloud metadata addresses are not allowed. Use a normal provider endpoint.',
      { isLocal },
    );
  }

  if (url.protocol === 'http:') {
    if (!isLocal && !(isPrivate && allowPrivateHttp)) {
      if (isPrivate) {
        return fail(
          'insecure',
          'Plain http:// is only allowed for the local network when you enable it in advanced settings. Use https:// or a loopback address.',
          { isLocal, warnings: ['Private network HTTP is disabled.'] },
        );
      }
      return fail(
        'insecure',
        'Remote endpoints must use https://. Only localhost and 127.0.0.1 may use http://.',
        { isLocal },
      );
    }
  }

  // Reject odd ports such as :0, and anything above 65535 (URL already clamps).
  if (url.port && url.port !== '443' && url.port !== '80' && Number(url.port) === 0) {
    return fail('malformed', 'The port in that URL is not valid.');
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  const baseUrl = `${url.protocol}//${url.host}${pathname}`;
  const warnings = [];
  if (url.protocol === 'http:') {
    warnings.push(
      isLocal
        ? 'Plain HTTP to a local address: the API key travels unencrypted on this machine only.'
        : 'Plain HTTP to a private network address: traffic is not encrypted.',
    );
  }
  if (isPrivate && !isLocal) {
    warnings.push('This endpoint is on a private network address.');
  }

  return { ok: true, url, baseUrl, host: url.host, isLocal, isPrivate, warnings };
}

/**
 * Build the chat completions URL from a base URL (and optional explicit path).
 *
 * Default strategy (OpenAI compatible):
 *   https://api.example.com        -> https://api.example.com/v1/chat/completions
 *   https://api.example.com/v1     -> https://api.example.com/v1/chat/completions
 *   https://api.example.com/openai/v1 -> .../openai/v1/chat/completions
 *   https://api.example.com/chat/completions -> unchanged
 */
export function buildChatCompletionsUrl(baseUrl, endpointPath = '') {
  const validated = validateBaseUrl(baseUrl, { allowPrivateHttp: true });
  if (!validated.ok) {
    throw new Error(validated.message);
  }
  const url = new URL(validated.baseUrl);
  let path = url.pathname.replace(/\/+$/, '');
  const override = typeof endpointPath === 'string' ? endpointPath.trim() : '';

  if (override) {
    if (!override.startsWith('/')) {
      throw new Error('The endpoint path must start with "/", for example /chat/completions.');
    }
    path = override.replace(/\/+$/, '');
  } else if (/\/chat\/completions$/i.test(path)) {
    // Already a full endpoint.
  } else if (/\/v\d+([a-z0-9.\-_]*)$/i.test(path)) {
    path = `${path}/chat/completions`;
  } else {
    path = `${path}/v1/chat/completions`;
  }

  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Build the (optional) model listing URL. */
export function buildModelsUrl(baseUrl, endpointPath = '') {
  const url = new URL(buildChatCompletionsUrl(baseUrl, endpointPath));
  url.pathname = url.pathname.replace(/\/chat\/completions$/i, '/models');
  return url.toString();
}

/** Normalise an endpoint path input; returns { ok, value, message }. */
export function validateEndpointPath(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: true, value: '' };
  if (/^https?:\/\//i.test(value)) {
    return { ok: false, value, message: 'Enter a path such as /chat/completions, not a full URL.' };
  }
  if (!value.startsWith('/')) {
    return { ok: false, value, message: 'The endpoint path must start with "/".' };
  }
  if (/\s/.test(value) || value.includes('..')) {
    return { ok: false, value, message: 'That endpoint path contains unsupported characters.' };
  }
  return { ok: true, value };
}

/** Human readable host (+ port) for display, never the full path. */
export function displayHost(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return String(url || '');
  }
}
