import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractJson,
  validateAgentResponse,
  parseAgentReply,
  buildUserPrompt,
  buildSystemPrompt,
  formatSnapshot,
} from '../src/lib/prompt.js';
import { makeSnapshot } from './helpers.mjs';

test('extracts JSON from plain, fenced and noisy replies', () => {
  assert.deepEqual(extractJson('{"done":true}'), { done: true });
  assert.deepEqual(extractJson('```json\n{"thought":"x"}\n```'), { thought: 'x' });
  assert.deepEqual(extractJson('Sure! Here you go:\n{"done": true}\nHope that helps.'), { done: true });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson('{"broken": '), null);
});

test('handles braces inside strings', () => {
  const parsed = extractJson('{"thought":"use {curly} braces","done":true}');
  assert.equal(parsed.thought, 'use {curly} braces');
});

test('validates a click action against the snapshot', () => {
  const snapshot = makeSnapshot();
  const result = validateAgentResponse(
    { thought: 'Click sign in', plan: ['click', 'verify'], action: { type: 'click', elementId: 1 }, done: false },
    snapshot,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.response.action, { type: 'click', elementId: 1 });
  assert.deepEqual(result.response.plan, ['click', 'verify']);
});

test('rejects hallucinated element ids and unknown actions', () => {
  const snapshot = makeSnapshot();
  const missing = validateAgentResponse({ action: { type: 'click', elementId: 42 } }, snapshot);
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /valid elementId/);

  const unknown = validateAgentResponse({ action: { type: 'teleport', elementId: 1 } }, snapshot);
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0], /Unknown action type/);

  const none = validateAgentResponse({ thought: 'thinking' }, snapshot);
  assert.equal(none.ok, false);
});

test('coerces element ids from strings', () => {
  const snapshot = makeSnapshot();
  const result = validateAgentResponse({ action: { type: 'click', elementId: '#2' } }, snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.response.action.elementId, 2);
});

test('sanitises typing and selection actions', () => {
  const snapshot = makeSnapshot();
  const typed = validateAgentResponse(
    { action: { type: 'type', elementId: 2, text: 'shoes', submit: true } },
    snapshot,
  );
  assert.equal(typed.ok, true);
  assert.deepEqual(typed.response.action, { type: 'type', elementId: 2, text: 'shoes', submit: true, clear: true });

  const missingText = validateAgentResponse({ action: { type: 'type', elementId: 2 } }, snapshot);
  assert.equal(missingText.ok, false);

  const select = validateAgentResponse(
    { action: { type: 'select', elementId: 2, value: 'large' } },
    snapshot,
  );
  assert.equal(select.ok, true);
  assert.equal(select.response.action.value, 'large');
});

test('rejects unsafe keys and non-http navigation', () => {
  const snapshot = makeSnapshot();
  const key = validateAgentResponse({ action: { type: 'key', key: 'F12' } }, snapshot);
  assert.equal(key.ok, false);

  const enter = validateAgentResponse({ action: { type: 'key', key: 'Enter' } }, snapshot);
  assert.equal(enter.ok, true);

  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'data:text/html,hi']) {
    const result = validateAgentResponse({ action: { type: 'navigate', url } }, snapshot);
    assert.equal(result.ok, false, url);
  }
});

test('clamps scroll and wait amounts', () => {
  const snapshot = makeSnapshot();
  const scroll = validateAgentResponse(
    { action: { type: 'scroll', direction: 'down', amount: 999999 } },
    snapshot,
  );
  assert.equal(scroll.response.action.amount, 4000);

  const wait = validateAgentResponse({ action: { type: 'wait', ms: 60000 } }, snapshot);
  assert.equal(wait.response.action.ms, 5000);
});

test('done responses need no action and carry the answer', () => {
  const snapshot = makeSnapshot();
  const result = validateAgentResponse({ done: true, answer: 'Added to cart.' }, snapshot);
  assert.equal(result.ok, true);
  assert.equal(result.response.done, true);
  assert.equal(result.response.action, null);
  assert.equal(result.response.answer, 'Added to cart.');

  const withAction = validateAgentResponse({ done: true, action: { type: 'done' } }, snapshot);
  assert.equal(withAction.response.done, true);
});

test('parseAgentReply combines extraction and validation', () => {
  const snapshot = makeSnapshot();
  const good = parseAgentReply('```json\n{"thought":"t","action":{"type":"click","elementId":1}}\n```', snapshot);
  assert.equal(good.ok, true);

  const bad = parseAgentReply('I would click the button.', snapshot);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /JSON/);
});

test('prompts include the goal, snapshot and history', () => {
  const prompt = buildUserPrompt({
    goal: 'Find the cheapest shoes',
    snapshot: makeSnapshot(),
    history: [{ step: 1, action: { type: 'click', elementId: 1 }, ok: true, observation: 'Clicked sign in' }],
    step: 2,
    maxSteps: 8,
  });
  assert.match(prompt, /Find the cheapest shoes/);
  assert.match(prompt, /#1 button "Sign in"/);
  assert.match(prompt, /STEP 2 of 8/);
  assert.match(prompt, /click #1/);
  assert.match(prompt, /Clicked sign in/);
});

test('snapshot formatting marks offscreen elements and truncation', () => {
  const snapshot = makeSnapshot();
  snapshot.truncatedElements = 12;
  const text = formatSnapshot(snapshot);
  assert.match(text, /offscreen/);
  assert.match(text, /12 more elements/);
  assert.match(text, /TITLE: Cart/);
});

test('system prompt demands raw JSON and a fixed action vocabulary', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /ONE JSON object/);
  for (const action of ['click', 'type', 'select', 'key', 'scroll', 'navigate', 'back', 'wait', 'extract', 'done']) {
    assert.match(prompt, new RegExp(action));
  }
  assert.match(prompt, /Never type passwords/);
});
