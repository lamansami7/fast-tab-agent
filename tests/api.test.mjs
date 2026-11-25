import test from 'node:test';
import assert from 'node:assert/strict';

import { chatCompletion, testConnection, listModels, buildRequestBody } from '../src/lib/api.js';
import { ProviderError } from '../src/lib/errors.js';
import { createFetchMock, jsonResponse, makeProvider } from './helpers.mjs';

const messages = [{ role: 'user', content: 'hello' }];

test('sends a conservative OpenAI-compatible request', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: { model: 'test-model', choices: [{ message: { content: 'hi there' }, finish_reason: 'stop' }] },
      url: 'https://api.example.com/v1/chat/completions',
    }),
  );

  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'hi there');
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.droppedParams, []);

  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-secret-key-123456');
  assert.equal(call.body.model, 'test-model');
  assert.deepEqual(call.body.messages, messages);
  assert.equal(call.body.stream, false);
  assert.equal('temperature' in call.body, false);
  assert.equal('response_format' in call.body, false);
  assert.equal('max_tokens' in call.body, false);
});

test('the configured API key is redacted from every model message', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({
    body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
  }));
  await chatCompletion(makeProvider(), [{ role: 'user', content: 'Do not expose sk-secret-key-123456 in this prompt' }], { fetchImpl });
  assert.equal(JSON.stringify(fetchImpl.calls[0].body.messages).includes('sk-secret-key-123456'), false);
});

test('redacts the configured key from nested message content too', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({
    body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] },
  }));
  await chatCompletion(makeProvider(), [{ role: 'user', content: [{ type: 'text', text: 'sk-secret-key-123456' }] }], { fetchImpl });
  assert.equal(JSON.stringify(fetchImpl.calls[0].body.messages).includes('sk-secret-key-123456'), false);
});

test('request body includes optional settings only when configured', () => {
  const provider = makeProvider({ temperature: 0.2, maxTokens: 300, params: { top_p: 0.9 } });
  const body = buildRequestBody(provider, messages, { jsonMode: true });
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 300);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.top_p, 0.9);
});

test('protected fields cannot be overridden by custom parameters', () => {
  const provider = makeProvider({
    params: { messages: [{ role: 'user', content: 'hacked' }], model: 'other', stream: true, top_k: 5 },
  });
  const body = buildRequestBody(provider, messages);
  assert.deepEqual(body.messages, messages);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.equal(body.top_k, 5);
});

test('authentication failures are classified and never leak the key', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      status: 401,
      body: { error: { message: 'Incorrect API key provided: sk-secret-key-123456' } },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'auth_failed');
      assert.equal(error.status, 401);
      assert.equal(error.message.includes('sk-secret-key-123456'), false);
      assert.equal(error.providerMessage.includes('sk-secret-key-123456'), false);
      assert.match(error.providerMessage, /\[redacted\]/);
      return true;
    },
  );
});

test('missing models are distinguished from missing endpoints', async () => {
  const modelFetch = createFetchMock(() =>
    jsonResponse({ status: 404, body: { error: { message: 'The model `foo` does not exist' } } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl: modelFetch }),
    (error) => error.code === 'model_unavailable',
  );

  const endpointFetch = createFetchMock(() =>
    jsonResponse({ status: 404, body: { detail: 'Not Found' } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl: endpointFetch }),
    (error) => error.code === 'endpoint_not_found',
  );
});

test('adapts to models that reject optional parameters', async () => {
  const fetchImpl = createFetchMock(({ callIndex }) => {
    if (callIndex === 0) {
      return jsonResponse({
        status: 400,
        body: { error: { message: 'Unsupported value: temperature is not supported with this model' } },
      });
    }
    return jsonResponse({ body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
  });

  const provider = makeProvider({ temperature: 0.7 });
  const result = await chatCompletion(provider, messages, { fetchImpl });
  assert.equal(result.content, 'ok');
  assert.deepEqual(result.droppedParams, ['temperature']);
  assert.equal('temperature' in fetchImpl.calls[0].body, true);
  assert.equal('temperature' in fetchImpl.calls[1].body, false);
});

test('retries rate limits once and then succeeds', async () => {
  const fetchImpl = createFetchMock(({ callIndex }) => {
    if (callIndex === 0) {
      return jsonResponse({ status: 429, body: { error: { message: 'rate limit' } }, headers: { 'retry-after': '0' } });
    }
    return jsonResponse({ body: { choices: [{ message: { content: 'after retry' } }] } });
  });
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'after retry');
  assert.equal(fetchImpl.calls.length, 2);
});

test('persistent rate limits surface as rate_limited', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '0' } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'rate_limited',
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('quota exhaustion maps to insufficient_quota', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      status: 429,
      body: { error: { message: 'You exceeded your current quota, please check your plan and billing details' } },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'insufficient_quota',
  );
});

test('server errors are retried then reported', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({ status: 503, body: { message: 'overloaded' } }));
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'server_error' && error.status === 503,
  );
});

test('non-JSON responses are rejected as invalid', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({ status: 200, body: '<html>proxy login</html>' }));
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'invalid_response',
  );
});

test('empty completions are rejected', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'invalid_response',
  );
});

test('content filter completions are labelled', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'content_filtered',
  );
});

test('automatic redirect following is disabled', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ message: { content: 'ok' } }] } }),
  );
  await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
});

test('cross-host redirects are refused', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      url: 'https://evil.example.net/chat/completions',
      body: { choices: [{ message: { content: 'ok' } }] },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'unexpected_redirect',
  );
});

test('same-host redirect responses are accepted but not followed silently', async () => {
  // Defence in depth: even if a response reports a same-host URL, it is used.
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      url: 'https://api.example.com/v1/chat/completions',
      body: { choices: [{ message: { content: 'ok' } }] },
    }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'ok');
});

test('network failures map to connection_failed', async () => {
  const fetchImpl = createFetchMock(() => {
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'connection_failed',
  );
});

test('timeouts abort the request', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl, timeoutMs: 20 }),
    (error) => error.code === 'timeout',
  );
});

test('a missing key blocks remote requests before any network call', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({ body: { choices: [] } }));
  await assert.rejects(
    () => chatCompletion(makeProvider({ apiKey: '' }), messages, { fetchImpl }),
    (error) => error.code === 'invalid_config' && /API key/i.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('plain http remote endpoints are refused at request time', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({ body: { choices: [] } }));
  const provider = makeProvider({ baseUrl: 'http://api.example.com/v1' });
  await assert.rejects(
    () => chatCompletion(provider, messages, { fetchImpl }),
    (error) => error.code === 'invalid_config' && /https/i.test(error.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('local http endpoints are allowed', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ message: { content: 'local ok' } }] } }),
  );
  const result = await chatCompletion(
    makeProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.2' }),
    messages,
    { fetchImpl },
  );
  assert.equal(result.content, 'local ok');
  assert.equal(fetchImpl.calls[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in fetchImpl.calls[0].init.headers, false);
});

test('custom endpoint paths are respected', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ message: { content: 'ok' } }] } }),
  );
  await chatCompletion(makeProvider({ endpointPath: '/v2/chat/completions' }), messages, { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v2/chat/completions');
});

test('content arrays and legacy choices[0].text are understood', async () => {
  const arrayFetch = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          { message: { content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] } },
        ],
      },
    }),
  );
  const arrayResult = await chatCompletion(makeProvider(), messages, { fetchImpl: arrayFetch });
  assert.equal(arrayResult.content, 'part one part two');

  const textFetch = createFetchMock(() =>
    jsonResponse({ body: { choices: [{ text: 'legacy completion' }] } }),
  );
  const textResult = await chatCompletion(makeProvider(), messages, { fetchImpl: textFetch });
  assert.equal(textResult.content, 'legacy completion');
});

test('testConnection reports success only for a real reply', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        model: 'test-model',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { total_tokens: 5 },
      },
    }),
  );
  const result = await testConnection(makeProvider(), { fetchImpl });
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.reply, 'ok');
  assert.equal(result.model, 'test-model');
  assert.equal(fetchImpl.calls[0].body.max_tokens, 24);
  assert.equal(fetchImpl.calls[0].body.messages.length, 1);
  assert.equal(JSON.stringify(result).includes('sk-secret-key-123456'), false);
});

test('testConnection reports auth failure and model problems', async () => {
  const auth = await testConnection(makeProvider(), {
    fetchImpl: createFetchMock(() => jsonResponse({ status: 401, body: { error: { message: 'bad key' } } })),
  });
  assert.equal(auth.status, 'auth_failed');
  assert.equal(auth.ok, false);

  const model = await testConnection(makeProvider(), {
    fetchImpl: createFetchMock(() =>
      jsonResponse({ status: 404, body: { error: { message: 'model not found' } } }),
    ),
  });
  assert.equal(model.status, 'model_unavailable');

  const rate = await testConnection(makeProvider(), {
    fetchImpl: createFetchMock(() =>
      jsonResponse({ status: 429, body: { error: { message: 'rate limited' } }, headers: { 'retry-after': '0' } }),
    ),
  });
  assert.equal(rate.status, 'rate_limited');
});

test('testConnection surfaces configuration problems without a request', async () => {
  const fetchImpl = createFetchMock(() => jsonResponse({ body: {} }));
  const result = await testConnection(makeProvider({ apiKey: '' }), { fetchImpl });
  assert.equal(result.status, 'invalid_config');
  assert.match(result.message, /API key/i);
  assert.equal(fetchImpl.calls.length, 0);
});

test('optional model discovery works and tolerates other shapes', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { data: [{ id: 'zeta' }, { id: 'alpha' }, { id: 'alpha' }] } }),
  );
  const result = await listModels(makeProvider(), { fetchImpl });
  assert.deepEqual(result.models, ['alpha', 'zeta']);
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v1/models');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.equal(fetchImpl.calls[0].init.credentials, 'omit');
});

test('model discovery refuses cross-host redirects and missing-key requests', async () => {
  const redirectFetch = createFetchMock(() => jsonResponse({
    status: 302,
    body: { error: 'redirect' },
    url: 'https://attacker.example/v1/models',
  }));
  await assert.rejects(
    () => listModels(makeProvider(), { fetchImpl: redirectFetch }),
    (error) => error.code === 'unexpected_redirect',
  );
  assert.equal(redirectFetch.calls[0].init.redirect, 'error');

  const noKeyFetch = createFetchMock(() => jsonResponse({ body: { data: [] } }));
  await assert.rejects(
    () => listModels(makeProvider({ apiKey: '' }), { fetchImpl: noKeyFetch }),
    (error) => error.code === 'invalid_config',
  );
  assert.equal(noKeyFetch.calls.length, 0);
});


test('extracts text from top-level output_text responses', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ body: { output_text: 'hello from output_text', choices: [] } }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'hello from output_text');
});

test('extracts text from Responses-API-like output arrays', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'part A' }, { type: 'output_text', text: ' part B' }] },
        ],
      },
    }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'part A part B');
});

test('extracts object-shaped text content parts', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: { value: 'hello', annotations: [] } },
                { type: 'text', text: ' world' },
              ],
            },
          },
        ],
      },
    }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'hello world');
});

test('extracts message content when content is a text object', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [{ message: { content: { type: 'text', text: 'object content' } }, finish_reason: 'stop' }],
      },
    }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'object content');
});

test('ignores reasoning parts in content arrays', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          {
            message: {
              content: [
                { type: 'reasoning', text: 'secret chain of thought' },
                { type: 'text', text: 'visible answer' },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      },
    }),
  );
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl });
  assert.equal(result.content, 'visible answer');
  assert.equal(result.content.includes('secret chain of thought'), false);
});

test('empty responses include finish reason and redacted shape diagnostics', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          {
            message: { content: null, role: 'assistant' },
            finish_reason: 'stop',
          },
        ],
      },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.match(error.message, /empty response/i);
      assert.match(error.providerMessage, /finish_reason=stop/);
      assert.match(error.providerMessage, /content=null/);
      assert.equal(error.providerMessage.includes('sk-secret-key-123456'), false);
      return true;
    },
  );
});

test('empty reasoning-only responses do not expose reasoning content', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          {
            message: { content: null, reasoning_content: 'private internal reasoning sk-secret-key-123456' },
            finish_reason: 'stop',
          },
        ],
      },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.match(error.message, /reasoning/i);
      assert.match(error.providerMessage, /reasoning_content=present/);
      assert.equal(error.providerMessage.includes('private internal reasoning'), false);
      assert.equal(error.providerMessage.includes('sk-secret-key-123456'), false);
      assert.equal(error.message.includes('private internal reasoning'), false);
      return true;
    },
  );
});

test('length-empty responses retry without max_tokens once', async () => {
  const fetchImpl = createFetchMock(({ callIndex }) => {
    if (callIndex === 0) {
      return jsonResponse({
        body: {
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
        },
      });
    }
    return jsonResponse({
      body: { choices: [{ message: { content: 'ok after retry' }, finish_reason: 'stop' }] },
    });
  });
  const provider = makeProvider({ maxTokens: 24 });
  const result = await chatCompletion(provider, messages, { fetchImpl });
  assert.equal(result.content, 'ok after retry');
  assert.ok(result.droppedParams.includes('max_tokens'));
  assert.equal('max_tokens' in fetchImpl.calls[1].body, false);
});

test('length-empty responses without recoverable token params report diagnostics', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
      },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => {
      assert.equal(error.code, 'invalid_response');
      assert.match(error.message, /token limit/i);
      assert.match(error.providerMessage, /finish_reason=length/);
      return true;
    },
  );
});

test('testConnection maps invalid_response to invalid_response status', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] },
    }),
  );
  const result = await testConnection(makeProvider(), { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_response');
  assert.equal(result.code, 'invalid_response');
  assert.match(result.providerMessage || '', /finish_reason=stop/);
});

test('testConnection maps content_filtered responses', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] },
    }),
  );
  const result = await testConnection(makeProvider(), { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'content_filtered');
  assert.equal(result.code, 'content_filtered');
});


test('200 responses with an error object are surfaced as provider errors', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: { error: { message: 'upstream failure', type: 'server_error' } },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 200);
      assert.match(error.providerMessage || error.message, /upstream failure/i);
      return true;
    },
  );
});

test('response_format is dropped on unsupported-parameter errors', async () => {
  const fetchImpl = createFetchMock(({ callIndex }) => {
    if (callIndex === 0) {
      return jsonResponse({
        status: 400,
        body: { error: { message: 'response_format is not supported by this model' } },
      });
    }
    return jsonResponse({ body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } });
  });
  const result = await chatCompletion(makeProvider(), messages, { fetchImpl, jsonMode: true });
  assert.equal(result.content, 'ok');
  assert.ok(result.droppedParams.includes('response_format'));
  assert.equal('response_format' in fetchImpl.calls[1].body, false);
});

test('authentication failures are not retried', async () => {
  const fetchImpl = createFetchMock(() =>
    jsonResponse({ status: 401, body: { error: { message: 'bad key' } } }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider(), messages, { fetchImpl }),
    (error) => error.code === 'auth_failed',
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('empty-response diagnostics are redacted and do not leak content', async () => {
  const secret = 'sk-secret-key-123456';
  const fetchImpl = createFetchMock(() =>
    jsonResponse({
      body: {
        choices: [
          {
            message: { content: '', role: 'assistant' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5 },
      },
    }),
  );
  await assert.rejects(
    () => chatCompletion(makeProvider({ apiKey: secret }), messages, { fetchImpl }),
    (error) => {
      assert.equal(error.providerMessage.includes(secret), false);
      assert.match(error.providerMessage, /finish_reason=stop/);
      assert.match(error.providerMessage, /choices=1/);
      return true;
    },
  );
});
