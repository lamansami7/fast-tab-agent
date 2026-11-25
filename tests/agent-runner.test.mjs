import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentTask } from '../src/lib/agent-runner.js';
import { ProviderError } from '../src/lib/errors.js';
import { makeSnapshot } from './helpers.mjs';

function modelQueue(replies) {
  let index = 0;
  const calls = [];
  const fn = async (messages) => {
    calls.push(messages);
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply instanceof Error) throw reply;
    return { content: typeof reply === 'string' ? reply : JSON.stringify(reply) };
  };
  fn.calls = calls;
  return fn;
}

function baseParams(overrides = {}) {
  return {
    goal: 'Sign in to the site',
    maxSteps: 8,
    callModel: modelQueue([{ done: true, answer: 'Done.' }]),
    getSnapshot: async () => makeSnapshot(),
    executeAction: async () => ({ ok: true, observation: 'Clicked.' }),
    ...overrides,
  };
}

test('runs actions until the model reports done', async () => {
  const callModel = modelQueue([
    { thought: 'Click sign in', action: { type: 'click', elementId: 1 } },
    { thought: 'Finished', done: true, answer: 'Opened the sign in page.' },
  ]);
  const executed = [];
  const events = [];

  const result = await runAgentTask(
    baseParams({
      callModel,
      executeAction: async (action) => {
        executed.push(action);
        return { ok: true, observation: 'Clicked the button.' };
      },
      onEvent: (event) => events.push(event),
    }),
  );

  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'Opened the sign in page.');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(executed, [{ type: 'click', elementId: 1 }]);
  assert.ok(events.some((event) => event.phase === 'thinking'));
  assert.ok(events.some((event) => event.phase === 'step'));
});

test('repairs malformed JSON with one extra model call', async () => {
  const callModel = modelQueue([
    'Sure, I will click the sign-in button now.',
    { thought: 'Click', action: { type: 'click', elementId: 1 } },
    { done: true, answer: 'Done.' },
  ]);

  const result = await runAgentTask(baseParams({ callModel }));
  assert.equal(result.status, 'done');
  assert.equal(callModel.calls.length, 3);
  // The repair turn includes the original reply and error feedback.
  assert.ok(callModel.calls[1].some((message) => /could not be used/i.test(message.content)));
});

test('fails cleanly when the model never returns usable JSON', async () => {
  const callModel = modelQueue(['not json at all']);
  const result = await runAgentTask(baseParams({ callModel }));
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'invalid_model_output');
});

test('validation failures get a repair turn', async () => {
  const callModel = modelQueue([
    { action: { type: 'click', elementId: 999 } },
    { action: { type: 'click', elementId: 1 } },
    { done: true, answer: 'ok' },
  ]);
  const result = await runAgentTask(baseParams({ callModel }));
  assert.equal(result.status, 'done');
  assert.equal(result.steps[0].ok, true);
});

test('provider errors surface their code and stop the run', async () => {
  const callModel = modelQueue([new ProviderError('auth_failed', 'Authentication failed.')]);
  const result = await runAgentTask(baseParams({ callModel }));
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'auth_failed');
});

test('cancellation stops before the next step', async () => {
  const callModel = modelQueue([{ action: { type: 'click', elementId: 1 } }]);
  const controller = new AbortController();
  const result = await runAgentTask(
    baseParams({
      callModel,
      signal: controller.signal,
      executeAction: async () => {
        controller.abort();
        return { ok: true, observation: 'Clicked.' };
      },
    }),
  );
  assert.equal(result.status, 'stopped');
  assert.equal(result.steps.length, 1);
});

test('cancellation before the first step', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runAgentTask(baseParams({ signal: controller.signal }));
  assert.equal(result.status, 'stopped');
  assert.equal(result.steps.length, 0);
});

test('repeated action failures stop the run instead of looping', async () => {
  const callModel = modelQueue([{ action: { type: 'click', elementId: 1 } }]);
  const result = await runAgentTask(
    baseParams({
      callModel,
      executeAction: async () => ({ ok: false, observation: 'Element is gone.' }),
    }),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.steps.length, 2);
  assert.match(result.error.message, /could not perform/i);
});

test('a single failure is recovered from', async () => {
  let attempts = 0;
  const callModel = modelQueue([
    { action: { type: 'click', elementId: 1 } },
    { action: { type: 'click', elementId: 2 } },
    { done: true, answer: 'Recovered.' },
  ]);
  const result = await runAgentTask(
    baseParams({
      callModel,
      executeAction: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, observation: 'Intercepted by cookie banner.' }
          : { ok: true, observation: 'Worked.' };
      },
    }),
  );
  assert.equal(result.status, 'done');
  assert.equal(result.answer, 'Recovered.');
});

test('step limits end the run with a clear note', async () => {
  const callModel = modelQueue([{ action: { type: 'click', elementId: 1 } }]);
  const result = await runAgentTask(baseParams({ callModel, maxSteps: 3 }));
  assert.equal(result.status, 'done');
  assert.equal(result.limitReached, true);
  assert.equal(result.steps.length, 3);
  assert.match(result.answer, /Stopped after 3 steps/);
});

test('page read failures are reported', async () => {
  const result = await runAgentTask(
    baseParams({
      getSnapshot: async () => {
        throw new Error('The page agent did not start on this tab.');
      },
    }),
  );
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'page_unavailable');
});

test('observations are recorded for the next turn', async () => {
  const callModel = modelQueue([
    { action: { type: 'click', elementId: 1 } },
    { done: true, answer: 'ok' },
  ]);
  await runAgentTask(
    baseParams({
      callModel,
      executeAction: async () => ({ ok: true, observation: 'Clicked "Sign in".' }),
    }),
  );
  const secondPrompt = callModel.calls[1].find((message) => message.role === 'user');
  assert.match(secondPrompt.content, /Clicked "Sign in"/);
});
