/**
 * Conversation model for the popup.
 *
 * A conversation is a plain array of messages, persisted in
 * `chrome.storage.local` (trusted extension contexts only). It intentionally
 * contains only what the user needs to re-read: their request and the agent's
 * final answer, plus a bounded list of actions that produced it.
 *
 * No provider records, API keys, full page text, or hidden model reasoning are
 * ever stored here. Live execution state still lives in
 * `chrome.storage.session` and is owned by the background worker.
 */

export const CHAT_STORAGE_KEY = 'fta.chat';
export const CHAT_VERSION = 1;

export const CHAT_LIMITS = {
  messages: 60,
  userText: 4000,
  assistantText: 12000,
  errorText: 700,
  hintText: 400,
  steps: 30,
  description: 200,
  observation: 500,
  taskId: 64,
  title: 120,
};

const ROLES = new Set(['user', 'assistant']);
const STATUSES = new Set(['running', 'done', 'stopped', 'error']);

let counter = 0;

function newId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `m_${cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  counter += 1;
  return `m_${Date.now().toString(36)}${counter.toString(36)}`;
}

export function clipChatText(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Truncate without destroying paragraph breaks in an answer. */
export function clipMultiline(value, max) {
  const text =
    typeof value === 'string'
      ? value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sanitizeSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const steps = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const step = Number(item.step);
    const description = clipChatText(item.description, CHAT_LIMITS.description);
    if (!description && !Number.isFinite(step)) continue;
    steps.push({
      step: Number.isFinite(step) ? step : steps.length + 1,
      description: description || 'action',
      ok: item.ok !== false,
      done: item.done === true,
      observation: clipChatText(item.observation, CHAT_LIMITS.observation),
    });
    if (steps.length >= CHAT_LIMITS.steps) break;
  }
  return steps;
}

/**
 * Create a message with a stable id and only known fields.
 * @param {{role:'user'|'assistant', text?:string, status?:string, taskId?:string|null, phase?:string, steps?:Array, error?:{message?:string,hint?:string}|null, tabTitle?:string, at?:number}} input
 */
export function createChatMessage(input = {}) {
  const role = input.role === 'assistant' ? 'assistant' : 'user';
  const message = {
    id: newId(),
    role,
    text: clipMultiline(input.text, role === 'user' ? CHAT_LIMITS.userText : CHAT_LIMITS.assistantText),
    at: Number.isFinite(input.at) ? input.at : Date.now(),
  };
  if (role === 'assistant') {
    if (STATUSES.has(input.status)) message.status = input.status;
    if (typeof input.taskId === 'string' && input.taskId) {
      message.taskId = input.taskId.slice(0, CHAT_LIMITS.taskId);
    }
    if (typeof input.phase === 'string' && input.phase) message.phase = input.phase.slice(0, 32);
    if (typeof input.tabTitle === 'string' && input.tabTitle) {
      message.tabTitle = clipChatText(input.tabTitle, CHAT_LIMITS.title);
    }
    if (Array.isArray(input.steps)) message.steps = sanitizeSteps(input.steps);
    if (input.error && typeof input.error === 'object' && typeof input.error.message === 'string') {
      message.error = {
        message: clipChatText(input.error.message, CHAT_LIMITS.errorText),
        hint: clipChatText(input.error.hint, CHAT_LIMITS.hintText),
      };
    }
  }
  return message;
}

/**
 * Coerce stored/imported data into a safe conversation. Drops unknown
 * properties so a corrupted storage entry cannot inject unexpected state.
 */
export function sanitizeChatMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const messages = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !ROLES.has(item.role)) continue;
    const text = clipMultiline(
      item.text,
      item.role === 'user' ? CHAT_LIMITS.userText : CHAT_LIMITS.assistantText,
    );
    if (item.role === 'user' && !text) continue;

    const message = {
      id: typeof item.id === 'string' && item.id ? item.id.slice(0, 64) : newId(),
      role: item.role,
      text,
      at: Number.isFinite(item.at) ? item.at : Date.now(),
    };
    if (item.role === 'assistant') {
      if (STATUSES.has(item.status)) message.status = item.status;
      if (typeof item.taskId === 'string' && item.taskId) {
        message.taskId = item.taskId.slice(0, CHAT_LIMITS.taskId);
      }
      if (typeof item.phase === 'string' && item.phase) message.phase = item.phase.slice(0, 32);
      if (typeof item.tabTitle === 'string' && item.tabTitle) {
        message.tabTitle = clipChatText(item.tabTitle, CHAT_LIMITS.title);
      }
      if (Array.isArray(item.steps)) message.steps = sanitizeSteps(item.steps);
      if (item.error && typeof item.error === 'object' && typeof item.error.message === 'string') {
        message.error = {
          message: clipChatText(item.error.message, CHAT_LIMITS.errorText),
          hint: clipChatText(item.error.hint, CHAT_LIMITS.hintText),
        };
      }
    }
    messages.push(message);
  }
  return trimChatMessages(messages);
}

/** Keep only the most recent messages. */
export function trimChatMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(Math.max(0, list.length - CHAT_LIMITS.messages));
}

/**
 * Map a background task snapshot onto an assistant message.
 * Only presentation-safe fields are copied.
 */
export function taskToMessagePatch(task) {
  if (!task || typeof task !== 'object') return {};
  const patch = {
    status: STATUSES.has(task.status) ? task.status : 'error',
    phase: typeof task.phase === 'string' ? task.phase : '',
    steps: sanitizeSteps(task.steps),
    text: clipMultiline(task.answer, CHAT_LIMITS.assistantText),
    tabTitle: clipChatText(task.tabTitle, CHAT_LIMITS.title),
  };
  if (task.error && typeof task.error === 'object' && typeof task.error.message === 'string') {
    patch.error = {
      message: clipChatText(task.error.message, CHAT_LIMITS.errorText),
      hint: clipChatText(task.error.hint, CHAT_LIMITS.hintText),
    };
  } else {
    patch.error = null;
  }
  if (task.limitReached === true) patch.limitReached = true;
  return patch;
}

/**
 * Storage-backed conversation store with an in-memory fallback for tests and
 * previews that run without chrome.storage.
 *
 * @param {{get?:Function,set?:Function,remove?:Function}|null} area
 */
export function createChatStore(area) {
  const usable = Boolean(area && typeof area.get === 'function' && typeof area.set === 'function');
  let memory = [];

  return {
    async load() {
      if (!usable) return trimChatMessages(memory);
      try {
        const bag = await area.get(CHAT_STORAGE_KEY);
        return sanitizeChatMessages(bag?.[CHAT_STORAGE_KEY]?.messages);
      } catch {
        return [];
      }
    },
    async save(messages) {
      const safe = sanitizeChatMessages(messages);
      memory = safe;
      if (!usable) return safe;
      try {
        await area.set({
          [CHAT_STORAGE_KEY]: { version: CHAT_VERSION, messages: safe, updatedAt: Date.now() },
        });
      } catch {
        /* the conversation is a convenience; never break the UI over it */
      }
      return safe;
    },
    async clear() {
      memory = [];
      if (!usable || typeof area.remove !== 'function') return;
      try {
        await area.remove(CHAT_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}
