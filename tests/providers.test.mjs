import test from 'node:test';
import assert from 'node:assert/strict';

import { PRESETS } from '../src/lib/presets.js';
import {
  createProvider,
  normalizeProvider,
  validateProvider,
  validateProviderForRequest,
  buildRequestHeaders,
  maskApiKey,
  publicProvider,
  providerForPopup,
  isValidProviderId,
} from '../src/lib/providers.js';

test('createProvider builds an editable record for every preset', () => {
  for (const preset of PRESETS) {
    const provider = createProvider(preset.id);
    assert.ok(isValidProviderId(provider.id), preset.id);
    assert.equal(provider.name, preset.name);
    assert.equal(provider.baseUrl, preset.baseUrl);
    assert.equal(provider.model, preset.suggestedModel || '');
    assert.equal(provider.type, 'preset');
    assert.equal(provider.presetId, preset.id);
    assert.equal(provider.apiKey, '');
    assert.equal(provider.authHeader, 'Authorization');
    assert.equal(provider.authScheme, 'Bearer');
    assert.ok(provider.createdAt > 0);
  }
});

test('custom providers start blank and unconstrained', () => {
  const provider = createProvider(null);
  assert.equal(provider.type, 'custom');
  assert.equal(provider.presetId, null);
  assert.equal(provider.baseUrl, '');
  assert.equal(provider.model, '');
});

test('ids are unique across rapid creation', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(createProvider(null).id);
  assert.equal(ids.size, 200);
});

test('multiple configurations can share a preset but not an id', () => {
  const a = createProvider('groq');
  const b = createProvider('groq');
  assert.notEqual(a.id, b.id);
  assert.equal(a.presetId, b.presetId);
});

test('normalizeProvider drops unknown fields and sanitises parameters', () => {
  const normalized = normalizeProvider({
    id: 'bogus id',
    name: '  My Proxy  ',
    presetId: 'not-a-preset',
    baseUrl: 'https://proxy.example.com/v1',
    apiKey: '  key123  ',
    model: '  some/model  ',
    temperature: 9,
    maxTokens: -5,
    params: {
      top_p: 0.9,
      nested: { a: 1, b: 'x' },
      badFn: () => 1,
      __proto__: { evil: true },
      list: [1, 'two', { skip: true }],
    },
    extraHeaders: { 'X-Title': 'Fast Tab Agent', 'Bad Header': 'x' },
    isAdmin: true,
  });

  assert.ok(isValidProviderId(normalized.id));
  assert.equal(normalized.name, 'My Proxy');
  assert.equal(normalized.type, 'custom');
  assert.equal(normalized.presetId, null);
  assert.equal(normalized.apiKey, 'key123');
  assert.equal(normalized.model, 'some/model');
  assert.equal(normalized.temperature, 2);
  assert.equal(normalized.maxTokens, 1);
  assert.deepEqual(normalized.params.nested, { a: 1, b: 'x' });
  assert.equal(normalized.params.badFn, undefined);
  assert.equal(normalized.params.isAdmin, undefined);
  assert.deepEqual(normalized.params.list, [1, 'two']);
  assert.equal('isAdmin' in normalized, false);
});

test('normalizeProvider rejects junk', () => {
  assert.equal(normalizeProvider(null), null);
  assert.equal(normalizeProvider('string'), null);
  assert.equal(normalizeProvider([]), null);
});

test('validateProvider reports field errors without blocking partial saves', () => {
  const empty = createProvider(null);
  const result = validateProvider(empty);
  assert.equal(result.valid, false);
  assert.ok(result.errors.baseUrl);
  assert.ok(result.errors.model);
  assert.equal(empty.name, 'Custom provider');

  empty.name = '   ';
  assert.ok(validateProvider(empty).errors.name);

  const good = createProvider('groq');
  good.apiKey = 'gsk_test';
  assert.equal(validateProvider(good).valid, true);
});

test('validateProvider rejects unsafe URLs and bad numbers', () => {
  const provider = createProvider('openai');
  provider.baseUrl = 'file:///etc/passwd';
  let result = validateProvider(provider);
  assert.match(result.errors.baseUrl, /Unsupported URL scheme/i);

  provider.baseUrl = 'https://user:pass@api.openai.com/v1';
  result = validateProvider(provider);
  assert.match(result.errors.baseUrl, /username or password/i);

  provider.baseUrl = 'https://api.openai.com/v1';
  provider.temperature = 5;
  result = validateProvider(provider);
  assert.ok(result.errors.temperature);
});

test('validateProviderForRequest requires a key for remote endpoints only', () => {
  const remote = createProvider('openai');
  remote.model = 'gpt-4o-mini';
  const noKey = validateProviderForRequest(remote);
  assert.equal(noKey.valid, false);
  assert.ok(noKey.errors.apiKey);

  remote.apiKey = 'sk-test';
  assert.equal(validateProviderForRequest(remote).valid, true);

  const local = createProvider('ollama');
  local.model = 'llama3.2';
  assert.equal(validateProviderForRequest(local).valid, true);
});

test('request headers never invent an auth header without a key', () => {
  const provider = createProvider('openai');
  provider.apiKey = '';
  const headers = buildRequestHeaders(provider);
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers['Content-Type'], 'application/json');
});

test('request headers honour custom header name, scheme and extras', () => {
  const provider = createProvider(null);
  provider.baseUrl = 'https://api.example.com/v1';
  provider.apiKey = 'abc123';
  provider.authHeader = 'api-key';
  provider.authScheme = '';
  provider.extraHeaders = { 'X-Title': 'Fast Tab Agent', 'Bad Header': 'nope' };

  const headers = buildRequestHeaders(provider);
  assert.equal(headers['api-key'], 'abc123');
  assert.equal(headers['X-Title'], 'Fast Tab Agent');
  assert.equal(headers['Bad Header'], undefined);
  assert.equal(headers.Authorization, undefined);

  provider.authHeader = 'Authorization';
  provider.authScheme = 'Token';
  assert.equal(buildRequestHeaders(provider).Authorization, 'Token abc123');
});

test('api keys are masked in display strings and stripped from public copies', () => {
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('short'), '••••');
  assert.equal(maskApiKey('sk-abcdefghijklmnop'), '••••mnop');

  const provider = createProvider('openai');
  provider.apiKey = 'sk-super-secret-key';
  const pub = publicProvider(provider);
  assert.equal('apiKey' in pub, false);
  assert.equal(pub.hasApiKey, true);
  assert.equal(providerForPopup(provider).apiKey, 'sk-super-secret-key');
});


test('NVIDIA NIM preset has the expected OpenAI-compatible configuration', () => {
  const provider = createProvider('nvidia');
  assert.equal(provider.type, 'preset');
  assert.equal(provider.presetId, 'nvidia');
  assert.equal(provider.name, 'NVIDIA NIM');
  assert.equal(provider.baseUrl, 'https://integrate.api.nvidia.com/v1');
  assert.equal(provider.model, 'meta/llama-3.3-70b-instruct');
  assert.equal(provider.endpointPath, '');
  assert.equal(provider.authHeader, 'Authorization');
  assert.equal(provider.authScheme, 'Bearer');
  const validation = validateProviderForRequest({ ...provider, apiKey: 'nvapi-test' });
  assert.equal(validation.valid, true);
});
