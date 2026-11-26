/**
 * The Fast Tab Agent task loop: analyse → plan → act → observe → replan.
 *
 * Dependencies are injected so the loop can be unit tested with fake models and
 * a fake page:
 *   callModel(messages, options) -> { content, ... }
 *   getSnapshot()                -> page snapshot
 *   executeAction(action)        -> { ok, observation }
 */

import { ERROR_CODES, ProviderError, friendlyError } from './errors.js';
import {
  ACTION_TYPES,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  describeAction,
  parseAgentReply,
} from './prompt.js';

const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_REPAIRS = 1;
const MAX_STAGNANT_REPEAT = 3;

function safeEmit(onEvent, event) {
  if (typeof onEvent !== 'function') return;
  try {
    onEvent(event);
  } catch {
    /* a broken listener must never break a task */
  }
}

/**
 * @param {{
 *   goal: string,
 *   mode?: 'act' | 'read',
 *   maxSteps: number,
 *   callModel: Function,
 *   getSnapshot: Function,
 *   executeAction: Function,
 *   onEvent?: Function,
 *   signal?: AbortSignal,
 *   checkCancelled?: Function,
 * }} params
 */
export async function runAgentTask(params) {
  const {
    goal,
    mode = 'act',
    maxSteps,
    callModel,
    getSnapshot,
    executeAction,
    onEvent,
    signal,
    checkCancelled,
  } = params;

  const steps = [];
  const history = [];
  // Keep the budget predictable even if callers supply a malformed value.
  const stepBudget = Math.max(1, Math.min(20, Math.floor(Number(maxSteps) || 1)));
  let consecutiveFailures = 0;
  let answer = '';
  let plan = [];
  let lastError = null;
  const visits = new Map();
  let recoveryNote = '';

  const isCancelled = () => {
    if (signal?.aborted) return true;
    if (typeof checkCancelled === 'function' && checkCancelled()) return true;
    return false;
  };

  const pushStep = (entry) => {
    steps.push(entry);
    safeEmit(onEvent, { phase: 'step', step: entry });
  };

  safeEmit(onEvent, { phase: 'start', goal, maxSteps: stepBudget });

  const systemPrompt = buildSystemPrompt();
  for (let step = 1; step <= stepBudget; step += 1) {
    if (isCancelled()) return { status: 'stopped', steps, answer, plan };

    safeEmit(onEvent, { phase: 'reading', step });
    let snapshot;
    try {
      snapshot = await getSnapshot();
    } catch (error) {
      if (isCancelled()) return { status: 'stopped', steps, answer, plan };
      lastError = new ProviderError(
        'page_unavailable',
        error?.message || 'Could not read the current tab.',
      );
      safeEmit(onEvent, { phase: 'error', error: friendlyError(lastError) });
      return { status: 'error', steps, answer, plan, error: friendlyError(lastError) };
    }
    // Reading the page may have taken long enough for the user to stop the task.
    if (isCancelled()) return { status: 'stopped', steps, answer, plan };

    safeEmit(onEvent, { phase: 'thinking', step: step });

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: buildUserPrompt({ goal, snapshot, history, step, maxSteps: stepBudget, note: recoveryNote, plan, mode }),
      },
    ];

    let replyText = '';
    let parsed = null;
    try {
      const result = await callModel(messages, { signal });
      if (isCancelled()) return { status: 'stopped', steps, answer, plan };
      replyText = result?.content || '';
      parsed = parseAgentReply(replyText, snapshot);
    } catch (error) {
      if (error instanceof ProviderError && error.code === ERROR_CODES.cancelled) {
        return { status: 'stopped', steps, answer, plan };
      }
      lastError = error;
      safeEmit(onEvent, { phase: 'error', error: friendlyError(error) });
      return { status: 'error', steps, answer, plan, error: friendlyError(error) };
    }

    // One repair round-trip if the model produced unusable JSON.
    let repairs = 0;
    while (!parsed.ok && repairs < MAX_REPAIRS) {
      repairs += 1;
      if (isCancelled()) return { status: 'stopped', steps, answer, plan };
      try {
        const repaired = await callModel(
          [
            ...messages,
            { role: 'assistant', content: replyText.slice(0, 1500) },
            { role: 'user', content: buildRepairPrompt({ errors: parsed.errors, previous: replyText }) },
          ],
          { signal },
        );
        if (isCancelled()) return { status: 'stopped', steps, answer, plan };
        replyText = repaired?.content || '';
        parsed = parseAgentReply(replyText, snapshot);
      } catch (error) {
        if (error instanceof ProviderError && error.code === ERROR_CODES.cancelled) {
          return { status: 'stopped', steps, answer, plan };
        }
        parsed = { ok: false, errors: [error?.message || 'The provider failed.'] };
      }
    }

    if (!parsed.ok) {
      const error = new ProviderError(
        ERROR_CODES.invalid_model_output,
        parsed.errors?.[0] || 'The model did not return a usable action.',
        { providerMessage: (replyText || '').slice(0, 240) },
      );
      pushStep({
        step,
        thought: '',
        plan: [],
        action: null,
        description: 'invalid model reply',
        ok: false,
        observation: error.message,
      });
      safeEmit(onEvent, { phase: 'error', error: friendlyError(error) });
      return { status: 'error', steps, answer, plan, error: friendlyError(error) };
    }

    const response = parsed.response;
    plan = response.plan.length ? response.plan : plan;

    if (response.done) {
      safeEmit(onEvent, { phase: 'finishing', step });
      answer = response.answer || answer;
      const entry = {
        step,
        thought: response.thought,
        plan,
        action: null,
        description: 'finish',
        ok: true,
        observation: answer,
        done: true,
      };
      pushStep(entry);
      history.push({ step, action: null, ok: true, observation: answer });
      return { status: 'done', steps, answer, plan };
    }

    const action = response.action;
    // Detect identical actions against an effectively unchanged page.
    const snapshotFingerprint = JSON.stringify({
      url: snapshot?.url || '', scroll: Math.round((snapshot?.scroll?.y || 0) / 40), title: snapshot?.title || '',
      elements: (snapshot?.elements || []).map((e) => [e.id, e.tag, e.label, e.value, e.checked, e.disabled, e.inViewport]),
      text: String(snapshot?.text || '').slice(0, 500),
    });
    const actionFingerprint = `${snapshotFingerprint}::${JSON.stringify(action)}`;
    const repeats = (visits.get(actionFingerprint) || 0) + 1;
    visits.set(actionFingerprint, repeats);
    if (repeats > MAX_STAGNANT_REPEAT) {
      const message = 'Stopped a repeated action cycle. Review the activity, then try a narrower request or take over manually.';
      safeEmit(onEvent, { phase: 'error', error: message });
      return { status: 'error', steps, answer: message, plan, error: { message }, stalled: true };
    }
    recoveryNote = repeats > 1
      ? 'This action has already been tried in this page state. Use a different approach or report the blocker.'
      : '';
    if (!action || !ACTION_TYPES.includes(action.type)) {
      const error = new ProviderError(ERROR_CODES.invalid_model_output, 'The model returned no action.');
      safeEmit(onEvent, { phase: 'error', error: friendlyError(error) });
      return { status: 'error', steps, answer, plan, error: friendlyError(error) };
    }

    if (isCancelled()) return { status: 'stopped', steps, answer, plan };

    // Announce the action before running it so the popup can show live progress.
    safeEmit(onEvent, {
      phase: 'action',
      step,
      plan,
      action: { type: action.type, ...(action.elementId ? { elementId: action.elementId } : {}) },
      description: describeAction(action),
    });

    let outcome;
    try {
      outcome = mode === 'read' && !['extract', 'wait'].includes(action.type)
        ? { ok: false, observation: 'Read-only mode blocked the action. Answer from this page without changing it.' }
        : await executeAction(action, snapshot);
    } catch (error) {
      outcome = { ok: false, observation: error?.message || 'The action could not be performed.' };
    }

    const ok = outcome?.ok === true;
    const observation = typeof outcome?.observation === 'string' ? outcome.observation : '';

    pushStep({
      step,
      thought: response.thought,
      plan,
      description: describeAction(action),
      ok,
      observation,
    });
    history.push({ step, action, ok, observation, error: ok ? '' : observation });

    if (isCancelled()) return { status: 'stopped', steps, answer, plan };
    if (outcome?.halt) {
      const error = { message: observation, hint: 'Review the selected tab before starting another task.' };
      safeEmit(onEvent, { phase: 'error', error });
      return { status: 'error', steps, answer, plan, error };
    }
    if (!ok) recoveryNote = 'The previous action failed. Inspect the fresh snapshot and choose a different target or method; do not assume the goal was completed.';
    if (ok) consecutiveFailures = 0;
    else consecutiveFailures += 1;

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const error = new ProviderError(
        'action_failed',
        'The agent could not perform an action on this page after repeated attempts.',
        { providerMessage: observation },
      );
      safeEmit(onEvent, { phase: 'error', error: friendlyError(error) });
      return { status: 'error', steps, answer, plan, error: friendlyError(error) };
    }
  }

  safeEmit(onEvent, { phase: 'limit', maxSteps: stepBudget });
  return {
    status: 'done',
    steps,
    answer: answer || `Stopped after ${stepBudget} steps — the goal may not be complete.`,
    plan,
    limitReached: true,
    stepsUsed: steps.length,
  };
}
