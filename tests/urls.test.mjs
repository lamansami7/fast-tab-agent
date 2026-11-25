import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBaseUrl,
  buildChatCompletionsUrl,
  buildModelsUrl,
  isLoopbackHost,
  isPrivateHost,
  isLinkLocalHost,
  validateEndpointPath,
} from '../src/lib/urls.js';

test('accepts https endpoints and canonicalises trailing slashes', () => {
  const result = validateBaseUrl(' https://api.openai.com/v1/ ');
  assert.equal(result.ok, true);
  assert.equal(result.baseUrl, 'https://api.openai.com/v1');
  assert.equal(result.host, 'api.openai.com');
  assert.equal(result.isLocal, false);
});

test('rejects non-http schemes', () => {
  for (const url of ['file:///etc/passwd', 'javascript://alert(1)', 'chrome://settings', 'data:text/plain,hi', 'ftp://example.com']) {
    const result = validateBaseUrl(url);
    assert.equal(result.ok, false, url);
    assert.equal(result.code, 'unsupported_scheme', url);
  }
});

test('rejects malformed URLs and missing schemes', () => {
  assert.equal(validateBaseUrl('api.example.com/v1').code, 'malformed');
  assert.equal(validateBaseUrl('https://').code, 'malformed');
  assert.equal(validateBaseUrl('https://api example.com').code, 'malformed');
  assert.equal(validateBaseUrl('').code, 'empty');
});

test('rejects embedded credentials', () => {
  const result = validateBaseUrl('https://user:pass@api.example.com/v1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'credentials');
});

test('requires https for remote hosts', () => {
  const result = validateBaseUrl('http://api.example.com/v1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'insecure');
  assert.match(result.message, /https/i);
});

test('allows http for loopback addresses only', () => {
  for (const url of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.1.2.3/v1',
    'http://[::1]:11434/v1',
  ]) {
    const result = validateBaseUrl(url);
    assert.equal(result.ok, true, url);
    assert.equal(result.isLocal, true, url);
    assert.ok(result.warnings.length > 0, url);
  }
});

test('private LAN http requires an explicit opt-in', () => {
  const blocked = validateBaseUrl('http://192.168.1.20:11434/v1');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'insecure');

  const allowed = validateBaseUrl('http://192.168.1.20:11434/v1', { allowPrivateHttp: true });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.isPrivate, true);
});

test('always rejects link-local and metadata addresses', () => {
  for (const url of ['http://169.254.169.254/latest', 'http://metadata.google.internal/v1']) {
    const result = validateBaseUrl(url, { allowPrivateHttp: true });
    assert.equal(result.ok, false, url);
    assert.equal(result.code, 'link_local', url);
  }
});

test('rejects query strings and fragments on base URLs', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1?key=1').code, 'query');
  assert.equal(validateBaseUrl('https://api.example.com/v1#frag').code, 'malformed');
});

test('host classifiers behave as documented', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('api.localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('172.16.0.5'), true);
  assert.equal(isPrivateHost('172.32.0.5'), false);
  assert.equal(isPrivateHost('192.168.0.10'), true);
  assert.equal(isLinkLocalHost('169.254.169.254'), true);
  assert.equal(isLinkLocalHost('example.com'), false);
});

test('builds chat completion URLs for every preset shape', () => {
  const cases = [
    ['https://integrate.api.nvidia.com/v1', 'https://integrate.api.nvidia.com/v1/chat/completions'],
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1/chat/completions'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.mistral.ai/v1', 'https://api.mistral.ai/v1/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(buildChatCompletionsUrl(input), expected, input);
  }
});

test('respects an already-complete endpoint and explicit paths', () => {
  assert.equal(
    buildChatCompletionsUrl('https://proxy.example.com/chat/completions'),
    'https://proxy.example.com/chat/completions',
  );
  assert.equal(
    buildChatCompletionsUrl('https://api.example.com', '/chat/completions'),
    'https://api.example.com/chat/completions',
  );
  assert.equal(
    buildChatCompletionsUrl('https://api.example.com/base', '/v2/chat/completions'),
    'https://api.example.com/v2/chat/completions',
  );
  assert.throws(() => buildChatCompletionsUrl('https://api.example.com', 'chat/completions'), /start with/);
});

test('builds the models URL from the chat endpoint', () => {
  assert.equal(buildModelsUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/models');
  assert.equal(
    buildModelsUrl('https://api.example.com', '/chat/completions'),
    'https://api.example.com/models',
  );
});

test('endpoint path validation', () => {
  assert.deepEqual(validateEndpointPath(''), { ok: true, value: '' });
  assert.equal(validateEndpointPath('/chat/completions').ok, true);
  assert.equal(validateEndpointPath('chat/completions').ok, false);
  assert.equal(validateEndpointPath('https://example.com/v1').ok, false);
  assert.equal(validateEndpointPath('/v1/../secret').ok, false);
});
