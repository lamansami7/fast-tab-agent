/**
 * Provider error handling.
 *
 * Different providers report failures differently: OpenAI-style
 * {error:{message,type,code}}, FastAPI {detail}, Mistral {message}, Ollama
 * {error:"..."}, or plain text / HTML from a proxy. `classifyHttpError` turns
 * all of that into one small, user-facing vocabulary that the popup renders and
 * the agent can reason about.
 *
 * API keys are never included in error messages: everything is passed through
 * `redact()` before it leaves the service worker.
 */

export const ERROR_CODES = {
  invalid_config: 'invalid_config',
  unsupported_scheme: 'unsupported_scheme',
  insecure_endpoint: 'insecure_endpoint',
  auth_failed: 'auth_failed',
  insufficient_quota: 'insufficient_quota',
  rate_limited: 'rate_limited',
  model_unavailable: 'model_unavailable',
  endpoint_not_found: 'endpoint_not_found',
  invalid_request: 'invalid_request',
  payload_too_large: 'payload_too_large',
  server_error: 'server_error',
  connection_failed: 'connection_failed',
  timeout: 'timeout',
  invalid_response: 'invalid_response',
  unexpected_redirect: 'unexpected_redirect',
  content_filtered: 'content_filtered',
  http_error: 'http_error',
  invalid_model_output: 'invalid_model_output',
  cancelled: 'cancelled',
  no_active_provider: 'no_active_provider',
  no_api_key: 'no_api_key',
  tab_unavailable: 'tab_unavailable',
  tab_restricted: 'tab_restricted',
  tab_permission_required: 'tab_permission_required',
};

const HINTS = {
  auth_failed: 'Check that the API key is correct, active, and allowed to use this model.',
  insufficient_quota: 'Your account is out of credit or over its billing limit for this provider.',
  rate_limited: 'The provider is rate limiting this key. Wait a moment and try again.',
  model_unavailable:
    'That model id is not available to this key. Check the exact id in the provider dashboard or use Fetch models — dots, hyphens and slashes must match exactly.',
  endpoint_not_found:
    'The endpoint path was not found. Check the base URL — it usually ends with /v1.',
  invalid_request: 'The provider rejected the request. Review your custom request parameters.',
  payload_too_large: 'The request was too large for this provider.',
  server_error: 'The provider had a server error. This is usually temporary.',
  connection_failed:
    'Could not reach the endpoint. Check the base URL, your network, and that the server is running. Redirects are refused, so use the final URL directly.',
  timeout: 'The provider did not respond in time.',
  invalid_response: 'The endpoint replied with something that is not an OpenAI-compatible response.',
  unexpected_redirect: 'The endpoint redirected to a different host. Requests are not forwarded.',
  content_filtered: 'The provider blocked the response with a content filter.',
  http_error: 'The provider returned an unexpected status code.',
  invalid_model_output: 'The model did not return usable JSON for the next step.',
  no_api_key: 'Add an API key for this provider.',
  invalid_config: 'Finish configuring this provider first.',
  cancelled: 'Cancelled.',
  no_active_provider: 'Add and activate an AI provider first.',
  tab_unavailable:
    'That tab is no longer open. Pick another tab or reopen the page, then try again.',
  tab_restricted:
    'Chrome does not allow extensions to read or control this page. Open a normal website instead.',
  tab_permission_required:
    'Website access is required before the agent can work on that tab. Grant access in the tab picker and try again.',
};

export function hintFor(code) {
  return HINTS[code] || '';
}

export class ProviderError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message short, user-facing, secret-free
   * @param {{status?:number, providerMessage?:string, retryable?:boolean, hint?:string, param?:string}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code || ERROR_CODES.http_error;
    this.status = opts.status ?? null;
    this.providerMessage = opts.providerMessage ?? '';
    this.retryable = Boolean(opts.retryable);
    this.hint = opts.hint ?? hintFor(this.code);
    this.param = opts.param ?? null;
    this.field = opts.field ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      status: this.status,
      providerMessage: this.providerMessage,
      retryable: this.retryable,
      param: this.param,
      field: this.field,
    };
  }
}

/** Replace a known secret (and generic bearer tokens) inside a string. */
export function redact(text, secret) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  if (secret && typeof secret === 'string' && secret.length >= 4) {
    out = out.split(secret).join('[redacted]');
    out = out.split(encodeURIComponent(secret)).join('[redacted]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [redacted]');
  out = out.replace(/\b(sk|pk|r8|gsk|xai|tgp)[-_][A-Za-z0-9._-]{12,}/g, '[redacted]');
  return out;
}

/** Shorten arbitrary provider text for display. */
export function clip(text, max = 320) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Pull the most useful message out of an unknown error payload. */
export function extractProviderMessage(payload, fallbackText = '') {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      if (typeof value.message === 'string') return value.message;
      if (typeof value.msg === 'string') return value.msg;
      if (Array.isArray(value)) return value.map(pick).filter(Boolean).join('; ');
    }
    return '';
  };

  if (payload && typeof payload === 'object') {
    const candidates = [
      payload.error,
      payload.detail,
      payload.message,
      payload.errors,
      payload.error_description,
      payload.msg,
    ];
    for (const candidate of candidates) {
      const text = pick(candidate);
      if (text) return clip(text);
    }
  }
  if (typeof payload === 'string' && payload.trim()) {
    // Strip HTML tags from proxy error pages before showing them.
    return clip(payload.replace(/<[^>]*>/g, ' '));
  }
  return clip(fallbackText);
}

const OPTIONAL_PARAMS = [
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'response_format',
  'presence_penalty',
  'frequency_penalty',
  'stream_options',
  'stop',
  'seed',
];

function detectUnsupportedParam(message) {
  if (!message) return null;
  const lower = message.toLowerCase();
  const mentionsUnsupported =
    /(unsupported|not supported|does not support|doesn't support|unknown|unrecognized|not allowed|invalid)/.test(
      lower,
    );
  if (!mentionsUnsupported) return null;
  for (const param of OPTIONAL_PARAMS) {
    if (lower.includes(param)) return param;
  }
  // e.g. "This model does not support the temperature parameter"
  if (/\bparams?\b|\bparameters?\b/.test(lower) && lower.includes('temperature')) return 'temperature';
  return null;
}

function looksLikeMissingModel(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (!/model/.test(lower)) return false;
  return /(not found|not exist|does not exist|doesn't exist|unknown|invalid|unavailable|no such|not available|not supported|unauthorized|deprecat)/.test(
    lower,
  );
}

/**
 * Map an HTTP failure to a ProviderError.
 *
 * @param {number} status
 * @param {any} payload parsed JSON body (may be null)
 * @param {string} rawText raw body text
 * @param {{secret?:string}} [options]
 */
export function classifyHttpError(status, payload, rawText, options = {}) {
  const providerMessage = redact(extractProviderMessage(payload, rawText), options.secret);
  const lower = providerMessage.toLowerCase();
  const hint = undefined;
  const base = { status, providerMessage };

  if (status === 401) {
    return new ProviderError(
      ERROR_CODES.auth_failed,
      'Authentication failed — the provider rejected your API key.',
      { ...base, hint },
    );
  }
  if (status === 403) {
    if (looksLikeMissingModel(providerMessage)) {
      return new ProviderError(
        ERROR_CODES.model_unavailable,
        'This key is not allowed to use that model.',
        base,
      );
    }
    if (/region|country|location/.test(lower)) {
      return new ProviderError(
        ERROR_CODES.auth_failed,
        'The provider blocked this request from your region.',
        base,
      );
    }
    return new ProviderError(
      ERROR_CODES.auth_failed,
      'Access forbidden — the key is valid but lacks permission for this request.',
      base,
    );
  }
  if (status === 402) {
    return new ProviderError(
      ERROR_CODES.insufficient_quota,
      'Payment required — the provider reports no remaining credit.',
      base,
    );
  }
  if (status === 404) {
    if (looksLikeMissingModel(providerMessage)) {
      return new ProviderError(
        ERROR_CODES.model_unavailable,
        'Model not available at this endpoint.',
        base,
      );
    }
    return new ProviderError(
      ERROR_CODES.endpoint_not_found,
      'Endpoint not found (404). Check the base URL path — it usually ends with /v1.',
      base,
    );
  }
  if (status === 413) {
    return new ProviderError(
      ERROR_CODES.payload_too_large,
      'The request is too large for this provider.',
      base,
    );
  }
  if (status === 429) {
    const quotaLike = /(quota|billing|credit|insufficient|exceeded your current)/.test(lower);
    return new ProviderError(
      quotaLike ? ERROR_CODES.insufficient_quota : ERROR_CODES.rate_limited,
      quotaLike
        ? 'Quota exceeded — the provider reports no remaining allowance for this key.'
        : 'Rate limited by the provider (429).',
      { ...base, retryable: true, hint },
    );
  }
  if (status === 400 || status === 422) {
    if (looksLikeMissingModel(providerMessage)) {
      return new ProviderError(
        ERROR_CODES.model_unavailable,
        'Model not available — check the exact model id.',
        base,
      );
    }
    const param = detectUnsupportedParam(providerMessage);
    if (param) {
      return new ProviderError(
        ERROR_CODES.invalid_request,
        `The provider rejected the "${param}" parameter.`,
        { ...base, param },
      );
    }
    return new ProviderError(
      ERROR_CODES.invalid_request,
      'The provider rejected the request as invalid.',
      base,
    );
  }
  if (status === 408 || status === 504) {
    return new ProviderError(
      ERROR_CODES.timeout,
      'The provider timed out.',
      { ...base, retryable: true },
    );
  }
  if (status >= 500) {
    return new ProviderError(
      ERROR_CODES.server_error,
      `Provider server error (${status}).`,
      { ...base, retryable: true },
    );
  }
  return new ProviderError(
    ERROR_CODES.http_error,
    providerMessage ? `Provider error (${status}).` : `Unexpected response (${status}).`,
    base,
  );
}

/** Wrap anything thrown into a ProviderError with a secret-free message. */
export function toProviderError(error, options = {}) {
  if (error instanceof ProviderError) {
    if (options.secret) {
      error.message = redact(error.message, options.secret);
      error.providerMessage = redact(error.providerMessage, options.secret);
    }
    return error;
  }
  const message = redact(error && error.message ? error.message : 'Unexpected error.', options.secret);
  return new ProviderError(ERROR_CODES.connection_failed, message);
}

export function friendlyError(error) {
  const err = toProviderError(error);
  return { code: err.code, message: err.message, hint: err.hint, status: err.status };
}
