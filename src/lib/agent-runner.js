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
  let consecutiveFailures = 0;
  let answer = '';
  let plan = [];
  let lastError = null;

  const isCancelled = () => {
    if (signal?.aborted) return true;
    if (typeof checkCancelled === 'function' && checkCancelled()) return true;
    return false;
  };

  const pushStep = (entry) => {
    steps.push(entry);
    safeEmit(onEvent, { phase: 'step', step: entry });
  };

  safeEmit(onEvent, { phase: 'start', goal, maxSteps });

  for (let step = 1; step <= maxSteps; step += 1) {
    if (isCancelled()) return { status: 'stopped', steps, answer, plan };

    let snapshot;
    try {
      snapshot = await getSnapshot();
    } catch (error) {
      lastError = new ProviderError(
        'page_unavailable',
        error?.message || 'Could not read the current tab.',
      );
      safeEmit(onEvent, { phase: 'error', error: friendlyError(lastError) });
      return { status: 'error', steps, answer, plan, error: friendlyError(lastError) };
    }

    safeEmit(onEvent, { phase: 'thinking', step: step });

    const messages = [
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({ goal, snapshot, history, step, maxSteps }),
      },
    ];

    let replyText = '';
    let parsed = null;
    try {
      const result = await callModel(messages, { signal });
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
      try {
        const repaired = await callModel(
          [
            ...messages,
            { role: 'assistant', content: replyText.slice(0, 1500) },
            { role: 'user', content: buildRepairPrompt({ errors: parsed.errors, previous: replyText }) },
          ],
          { signal },
        );
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
    if (!action || !ACTION_TYPES.includes(action.type)) {
      const error = new ProviderError(ERROR_CODES.invalid_model_output, 'The model returned no action.');
      safeEmit(onEvent, { phase: 'error', error: friendlyError(error) });
      return { status: 'error', steps, answer, plan, error: friendlyError(error) };
    }

    if (isCancelled()) return { status: 'stopped', steps, answer, plan };

    let outcome;
    try {
      outcome = await executeAction(action);
    } catch (error) {
      outcome = { ok: false, observation: error?.message || 'The action could not be performed.' };
    }

    const ok = outcome?.ok !== false;
    const observation = typeof outcome?.observation === 'string' ? outcome.observation : '';

    pushStep({
      step,
      thought: response.thought,
      plan,
      action,
      description: describeAction(action),
      ok,
      observation,
    });
    history.push({ step, action, ok, observation, error: ok ? '' : observation });

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

  safeEmit(onEvent, { phase: 'limit', maxSteps });
  return {
    status: 'done',
    steps,
    answer: answer || `Stopped after ${maxSteps} steps — the goal may not be complete.`,
    plan,
    limitReached: true,
  };
}
