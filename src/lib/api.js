/**
 * OpenAI-compatible HTTP transport.
 *
 * This module is only ever imported by the background service worker. The popup
 * and content scripts talk to it through chrome.runtime messages, so an API key
 * never leaves the extension's privileged context.
 *
 * Design notes:
 *  - conservative request body (model + messages only, optional settings);
 *  - adaptive fallback: if a provider rejects an optional parameter (some
 *    models refuse temperature/max_tokens/response_format), that parameter is
 *    removed and the call retried once;
 *  - one retry for 429/5xx with Retry-After support;
 *  - cross-host redirects are treated as failures instead of silently moving
 *    the API key to another destination;
 *  - every error message passes through redact().
 */

import { LIMITS, TEST_STATUS } from './constants.js';
import {
  ERROR_CODES,
  ProviderError,
  classifyHttpError,
  redact,
  toProviderError,
  hintFor,
} from './errors.js';
import { buildChatCompletionsUrl, buildModelsUrl, validateBaseUrl } from './urls.js';
import { buildRequestHeaders, validateProviderForRequest } from './providers.js';

const MAX_ATTEMPTS = 3;
const RETRYABLE_STRIP_PARAMS = new Set([
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'response_format',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'stop',
  'seed',
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError(ERROR_CODES.cancelled, 'Cancelled.'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new ProviderError(ERROR_CODES.cancelled, 'Cancelled.'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function redirectIsSafe(originalUrl, finalUrl) {
  if (!finalUrl) return true;
  try {
    const from = new URL(originalUrl);
    const to = new URL(finalUrl);
    if (from.host !== to.host) return false;
    if (from.protocol === 'http:' && to.protocol === 'https:') return true;
    return from.protocol === to.protocol;
  } catch {
    return false;
  }
}

/** Merge user parameters without letting them replace the agent protocol. */
function mergeCustomParams(body, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return body;
  const protectedKeys = new Set(['messages', 'stream', 'model']);
  for (const [key, value] of Object.entries(params)) {
    if (protectedKeys.has(key)) continue;
    body[key] = value;
  }
  return body;
}

/**
 * Build a conservative OpenAI-compatible chat completions body.
 */
export function buildRequestBody(provider, messages, options = {}) {
  const body = {
    model: provider.model,
    messages,
    stream: false,
  };

  const temperature = options.temperature ?? provider.temperature;
  if (temperature !== null && temperature !== undefined && temperature !== '' && Number.isFinite(Number(temperature))) {
    body.temperature = Number(temperature);
  }
  const maxTokens = options.maxTokens ?? provider.maxTokens;
  if (maxTokens !== null && maxTokens !== undefined && maxTokens !== '' && Number.isFinite(Number(maxTokens))) {
    body.max_tokens = Math.max(1, Math.min(LIMITS.maxTokensLimit, Math.floor(Number(maxTokens))));
  }
  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return mergeCustomParams(body, provider.params);
}

function extractContent(payload) {
  const choice = payload?.choices?.[0];
  if (!choice) return { content: '', finishReason: null };
  let content = choice.message?.content;
  if (Array.isArray(content)) {
    content = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (typeof content !== 'string') {
    content = typeof choice.text === 'string' ? choice.text : '';
  }
  // Some gateways return refusals separately.
  if (!content && typeof choice.message?.refusal === 'string') {
    content = choice.message.refusal;
  }
  return { content, finishReason: choice.finish_reason || null };
}

function detectParamFromBody(msg) {
  const lower = String(msg || '').toLowerCase();
  for (const param of RETRYABLE_STRIP_PARAMS) {
    if (lower.includes(param)) return param;
  }
  return null;
}

/**
 * Send one chat completion request.
 *
 * @param {object} provider normalized provider record
 * @param {Array<{role:string,content:string}>} messages
 * @param {{maxTokens?:number, temperature?:number|null, jsonMode?:boolean,
 *          timeoutMs?:number, signal?:AbortSignal, fetchImpl?:Function}} [options]
 * @returns {Promise<{content:string, model:string, usage:object|null, latencyMs:number,
 *                    attempts:number, droppedParams:string[], finishReason:string|null, endpoint:string}>}
 */
export async function chatCompletion(provider, messages, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new ProviderError(ERROR_CODES.connection_failed, 'Network access is unavailable.');
  }

  const requestCheck = validateProviderForRequest(provider, {
    allowPrivateHttp: options.allowPrivateHttp === true,
  });
  if (!requestCheck.valid) {
    const [field, message] = Object.entries(requestCheck.errors)[0] || ['config', 'Invalid configuration.'];
    throw new ProviderError(ERROR_CODES.invalid_config, message, { hint: message, field });
  }

  let endpoint;
  try {
    endpoint = buildChatCompletionsUrl(provider.baseUrl, provider.endpointPath);
  } catch (error) {
    throw new ProviderError(ERROR_CODES.invalid_config, error.message);
  }

  const headers = buildRequestHeaders(provider);
  const body = buildRequestBody(provider, messages, options);
  const timeoutMs = options.timeoutMs || LIMITS.requestTimeoutMs;
  const dropped = [];
  let lastError = null;
  let attempt = 0;
  const startedAt = Date.now();

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', abortFromParent, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        // Never let the browser forward this request (and its API key) to a
        // different destination. A redirect fails the call instead.
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener?.('abort', abortFromParent);
      if (options.signal?.aborted) {
        throw new ProviderError(ERROR_CODES.cancelled, 'Cancelled.');
      }
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        throw new ProviderError(
          ERROR_CODES.timeout,
          `No response from the provider after ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
      // Mixed content, DNS failure, refused connection: all "connection failed".
      const detail = redact(error?.message || 'Network request failed.', provider.apiKey);
      throw new ProviderError(
        ERROR_CODES.connection_failed,
        `Could not reach ${new URL(endpoint).host}.`,
        { providerMessage: detail, hint: hintFor(ERROR_CODES.connection_failed) },
      );
    }
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', abortFromParent);

    if (!redirectIsSafe(endpoint, response.url)) {
      throw new ProviderError(
        ERROR_CODES.unexpected_redirect,
        'The endpoint redirected to a different host. The request was not sent there.',
      );
    }

    const rawText = await response.text().catch(() => '');
    let payload = null;
    let parseError = null;
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch (error) {
        parseError = error;
      }
    }

    if (!response.ok) {
      const classified = classifyHttpError(response.status, payload, rawText, {
        secret: provider.apiKey,
      });

      // Adaptive compatibility: drop an optional parameter the model refuses.
      const param =
        classified.param ||
        (response.status === 400 || response.status === 422
          ? detectParamFromBody(classified.providerMessage)
          : null);
      if (
        param &&
        Object.prototype.hasOwnProperty.call(body, param) &&
        !dropped.includes(param) &&
        attempt < MAX_ATTEMPTS
      ) {
        delete body[param];
        dropped.push(param);
        lastError = classified;
        continue;
      }

      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const canRetry =
        (response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS;
      if (canRetry) {
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 4000)
          : Math.min(600 * 2 ** (attempt - 1), 2000);
        lastError = classified;
        await sleep(waitMs, options.signal);
        continue;
      }
      throw classified;
    }

    if (parseError || payload === null) {
      throw new ProviderError(
        ERROR_CODES.invalid_response,
        'The endpoint did not return JSON. It may not be an OpenAI-compatible API.',
        { status: response.status, providerMessage: redact(rawText.slice(0, 240), provider.apiKey) },
      );
    }
    if (payload.error) {
      // Some gateways return 200 with an error object.
      const classified = classifyHttpError(400, { error: payload.error }, rawText, {
        secret: provider.apiKey,
      });
      throw new ProviderError(classified.code, classified.message, {
        status: response.status,
        providerMessage: classified.providerMessage,
        hint: classified.hint,
      });
    }

    const { content, finishReason } = extractContent(payload);
    if (!content.trim()) {
      throw new ProviderError(
        finishReason === 'content_filter' ? ERROR_CODES.content_filtered : ERROR_CODES.invalid_response,
        finishReason === 'content_filter'
          ? 'The provider blocked the response with a content filter.'
          : 'The provider returned an empty response.',
        { status: response.status },
      );
    }

    return {
      content,
      model: typeof payload.model === 'string' ? payload.model : provider.model,
      usage: payload.usage && typeof payload.usage === 'object' ? payload.usage : null,
      finishReason: finishReason || null,
      latencyMs: Date.now() - startedAt,
      attempts: attempt,
      droppedParams: dropped,
      endpoint,
    };
  }

  throw toProviderError(lastError || new ProviderError(ERROR_CODES.connection_failed, 'Request failed.'));
}

function testStatusForCode(code) {
  switch (code) {
    case ERROR_CODES.auth_failed:
      return TEST_STATUS.authFailed;
    case ERROR_CODES.model_unavailable:
      return TEST_STATUS.modelUnavailable;
    case ERROR_CODES.rateLimited:
    case ERROR_CODES.rate_limited:
      return TEST_STATUS.rateLimited;
    case ERROR_CODES.insufficient_quota:
      return TEST_STATUS.insufficientQuota;
    case ERROR_CODES.endpoint_not_found:
    case ERROR_CODES.invalid_response:
    case ERROR_CODES.unexpected_redirect:
      return TEST_STATUS.unsupportedEndpoint;
    case ERROR_CODES.connection_failed:
      return TEST_STATUS.connectionFailed;
    case ERROR_CODES.timeout:
      return TEST_STATUS.timeout;
    case ERROR_CODES.invalid_config:
      return TEST_STATUS.invalidConfig;
    case ERROR_CODES.server_error:
      return TEST_STATUS.serverError;
    case ERROR_CODES.invalid_request:
      return TEST_STATUS.invalidConfig;
    default:
      return TEST_STATUS.httpError;
  }
}

/**
 * Validate + probe a provider with a minimal chat request.
 * Never returns the API key, and never claims success without a real reply.
 */
export async function testConnection(provider, options = {}) {
  const check = validateProviderForRequest(provider, {
    allowPrivateHttp: options.allowPrivateHttp === true,
  });
  if (!check.valid) {
    const [field, message] = Object.entries(check.errors)[0] || ['config', 'Invalid configuration.'];
    return {
      status: TEST_STATUS.invalidConfig,
      ok: false,
      code: ERROR_CODES.invalid_config,
      message,
      field,
      hint: message,
      endpoint: '',
      host: '',
      latencyMs: 0,
    };
  }

  const urlCheck = validateBaseUrl(provider.baseUrl, {
    allowPrivateHttp: options.allowPrivateHttp === true,
  });
  let endpoint = '';
  try {
    endpoint = buildChatCompletionsUrl(provider.baseUrl, provider.endpointPath);
  } catch (error) {
    return {
      status: TEST_STATUS.invalidConfig,
      ok: false,
      code: ERROR_CODES.invalid_config,
      message: error.message,
      hint: error.message,
      endpoint: '',
      host: '',
      latencyMs: 0,
    };
  }
  const host = urlCheck.ok ? urlCheck.host : '';

  const startedAt = Date.now();
  try {
    const result = await chatCompletion(
      provider,
      [
        {
          role: 'user',
          content: 'Connectivity check from Fast Tab Agent. Reply with the single word: ok.',
        },
      ],
      {
        maxTokens: LIMITS.testMaxTokens,
        jsonMode: false,
        timeoutMs: options.timeoutMs || LIMITS.testTimeoutMs,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
      },
    );
    return {
      status: TEST_STATUS.success,
      ok: true,
      message: `Connected to ${host}.`,
      reply: redact(result.content.trim().slice(0, 160), provider.apiKey),
      model: result.model,
      httpStatus: 200,
      endpoint,
      host,
      latencyMs: result.latencyMs || Date.now() - startedAt,
      droppedParams: result.droppedParams,
      code: null,
      hint: result.droppedParams.length
        ? `This model does not accept: ${result.droppedParams.join(', ')}. Those settings were skipped.`
        : '',
    };
  } catch (error) {
    const err = toProviderError(error, { secret: provider.apiKey });
    return {
      status: testStatusForCode(err.code),
      ok: false,
      code: err.code,
      message: err.message,
      hint: err.hint,
      providerMessage: err.providerMessage,
      httpStatus: err.status,
      endpoint,
      host,
      latencyMs: Date.now() - startedAt,
      field: err.field || null,
    };
  }
}

/**
 * Optional model discovery (GET /models). Never required by the extension.
 */
export async function listModels(provider, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let endpoint;
  try {
    endpoint = buildModelsUrl(provider.baseUrl, provider.endpointPath);
  } catch (error) {
    throw new ProviderError(ERROR_CODES.invalid_config, error.message);
  }
  const headers = buildRequestHeaders(provider);
  delete headers['Content-Type'];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || LIMITS.testTimeoutMs);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    throw new ProviderError(
      controller.signal.aborted ? ERROR_CODES.timeout : ERROR_CODES.connection_failed,
      'Could not reach the models endpoint.',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text().catch(() => '');
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!response.ok) {
    throw classifyHttpError(response.status, payload, text, { secret: provider.apiKey });
  }
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];
  const models = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id || entry?.name || entry?.model))
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  return { models: Array.from(new Set(models)).sort(), endpoint };
}
