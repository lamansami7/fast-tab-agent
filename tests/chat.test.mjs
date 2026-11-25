import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_LIMITS,
  CHAT_STORAGE_KEY,
  clipMultiline,
  createChatMessage,
  createChatStore,
  sanitizeChatMessages,
  taskToMessagePatch,
  trimChatMessages,
} from '../src/lib/chat.js';
import { createStorageArea } from './helpers.mjs';

test('messages get unique ids and only known fields', () => {
  const first = createChatMessage({ role: 'user', text: '  Summarize this page.  ' });
  const second = createChatMessage({ role: 'user', text: 'Summarize this page.' });
  assert.notEqual(first.id, second.id);
  assert.equal(first.role, 'user');
  assert.equal(first.text, 'Summarize this page.');
  assert.equal('status' in first, false, 'user messages do not carry task state');
  assert.ok(first.at > 0);
});

test('answers keep paragraph breaks while being bounded', () => {
  const answer = 'Line one.\n\nLine two.\n\n\n\nLine four.';
  assert.equal(clipMultiline(answer, 500), 'Line one.\n\nLine two.\n\nLine four.');
  assert.equal(clipMultiline('  ', 10), '');
  const capped = clipMultiline('x'.repeat(40), 20);
  assert.equal(capped.length, 20);
  assert.match(capped, /…$/);
});

test('assistant messages keep bounded task presentation data', () => {
  const message = createChatMessage({
    role: 'assistant',
    status: 'done',
    taskId: 'task_abc',
    phase: 'done',
    tabTitle: 'Example page',
    text: 'A'.repeat(CHAT_LIMITS.assistantText + 20),
    steps: Array.from({ length: 40 }, (_, index) => ({
      step: index + 1,
      description: `Step ${index + 1}`,
      ok: index !== 0,
      observation: 'Observed',
    })),
    error: { message: 'Nope', hint: 'Try again' },
  });
  assert.equal(message.status, 'done');
  assert.equal(message.steps.length, CHAT_LIMITS.steps);
  assert.equal(message.text.length, CHAT_LIMITS.assistantText);
  assert.equal(message.error.message, 'Nope');
  assert.equal(message.error.hint, 'Try again');
  assert.equal('apiKey' in message, false);
});

test('sanitising drops unknown roles, empty user turns and junk fields', () => {
  const clean = sanitizeChatMessages([
    { role: 'system', text: 'ignore me' },
    { role: 'user', text: '   ' },
    {
      role: 'user',
      text: '  Hello  ',
      apiKey: 'sk-secret',
      evil: '<script>',
    },
    {
      role: 'assistant',
      text: 'Hi',
      status: 'not-a-status',
      steps: [{ step: 1, description: 'click', ok: true, observation: 'ok', secret: 'x' }],
    },
  ]);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].text, 'Hello');
  assert.equal('apiKey' in clean[0], false);
  assert.equal('evil' in clean[0], false);
  assert.equal(clean[1].status, undefined);
  assert.equal('secret' in clean[1].steps[0], false);
});

test('conversations are trimmed to the most recent messages', () => {
  const messages = Array.from({ length: CHAT_LIMITS.messages + 15 }, (_, index) => ({
    role: 'user',
    text: `Message ${index}`,
    at: index,
  }));
  const trimmed = trimChatMessages(messages);
  assert.equal(trimmed.length, CHAT_LIMITS.messages);
  assert.equal(trimmed[0].text, 'Message 15');
  assert.equal(trimmed.at(-1).text, `Message ${CHAT_LIMITS.messages + 14}`);
});

test('task snapshots map to a safe assistant message patch', () => {
  const patch = taskToMessagePatch({
    status: 'done',
    phase: 'done',
    answer: 'The refund policy is 30 days.\n\nSee section 4.',
    tabTitle: 'Help centre',
    limitReached: true,
    error: null,
    steps: [
      { step: 1, description: 'click #2', ok: true, observation: 'Clicked Refunds.' },
      { step: 2, description: 'finish', ok: true, done: true, observation: '30 days' },
    ],
    provider: { apiKey: 'should-not-copy' },
  });
  assert.equal(patch.status, 'done');
  assert.equal(patch.text, 'The refund policy is 30 days.\n\nSee section 4.');
  assert.equal(patch.steps.length, 2);
  assert.equal(patch.limitReached, true);
  assert.equal(patch.error, null);
  assert.equal('provider' in patch, false);
});

test('task errors are clipped and keep their hint', () => {
  const patch = taskToMessagePatch({
    status: 'error',
    phase: 'error',
    answer: '',
    error: { message: 'E'.repeat(2000), hint: 'H'.repeat(1000) },
    steps: [],
  });
  assert.equal(patch.status, 'error');
  assert.equal(patch.error.message.length, CHAT_LIMITS.errorText);
  assert.equal(patch.error.hint.length, CHAT_LIMITS.hintText);
});

test('the chat store persists, reloads and clears conversations', async () => {
  const area = createStorageArea();
  const store = createChatStore(area);
  const messages = [
    createChatMessage({ role: 'user', text: 'Find refunds' }),
    createChatMessage({ role: 'assistant', text: '30 days', status: 'done', taskId: 'task_1' }),
  ];

  assert.deepEqual(await store.load(), []);
  await store.save(messages);
  const stored = area.dump()[CHAT_STORAGE_KEY];
  assert.equal(stored.version, 1);
  assert.equal(stored.messages.length, 2);
  assert.equal(stored.messages[1].taskId, 'task_1');

  const loaded = await store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].text, 'Find refunds');
  assert.equal(loaded[1].text, '30 days');

  await store.clear();
  assert.deepEqual(await store.load(), []);
  assert.equal(area.dump()[CHAT_STORAGE_KEY], undefined);
});

test('the chat store survives corrupted or unavailable storage', async () => {
  const area = createStorageArea({ [CHAT_STORAGE_KEY]: { messages: 'nope' } });
  const store = createChatStore(area);
  assert.deepEqual(await store.load(), []);

  const missingArea = {
    async get() {
      throw new Error('boom');
    },
    async set() {
      throw new Error('boom');
    },
  };
  const resilient = createChatStore(missingArea);
  assert.deepEqual(await resilient.load(), []);
  await resilient.save([createChatMessage({ role: 'user', text: 'still works' })]);

  const memoryStore = createChatStore(null);
  await memoryStore.save([createChatMessage({ role: 'user', text: 'memory' })]);
  assert.equal((await memoryStore.load())[0].text, 'memory');
});
