/**
 * Agent prompting + strict parsing of the model's action JSON.
 *
 * The model is asked for one JSON object per turn. Everything it returns is
 * validated against the live page snapshot before anything touches the DOM, so
 * a hallucinated element id can only produce a retry, never a stray click.
 */

export const ACTION_TYPES = [
  'click',
  'type',
  'select',
  'key',
  'scroll',
  'navigate',
  'back',
  'wait',
  'extract',
  'done',
];

const KEY_ALLOWLIST = new Set([
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
]);

const MAX_TEXT_LENGTH = 2000;
const MAX_PAGE_TEXT = 3200;
const MAX_ELEMENTS = 90;

export function buildSystemPrompt() {
  return `You are Fast Tab Agent, an autonomous browser agent operating one real Chrome tab on behalf of the user.

Each turn you receive: the user's goal, a compact snapshot of the current page, and the history of your previous steps. Reply with exactly ONE JSON object and nothing else.

Response schema:
{
  "thought": "one short sentence about the next move",
  "plan": ["remaining step", "..."],
  "action": { ... },
  "done": false,
  "answer": ""
}

Available actions:
- {"type":"click","elementId":12}
- {"type":"type","elementId":7,"text":"search terms","submit":true,"clear":true}
- {"type":"select","elementId":9,"value":"option value"}
- {"type":"key","key":"Enter"}            (Enter, Escape, Tab, Arrow keys, PageUp/PageDown, Home, End)
- {"type":"scroll","direction":"down","amount":600}
- {"type":"navigate","url":"https://example.com/path"}
- {"type":"back"}
- {"type":"wait","ms":800}
- {"type":"extract","elementId":3,"what":"the price"}   (omit elementId to read the page)
- {"type":"done"}

Rules:
1. Output raw JSON only. No markdown fences, no commentary.
2. Only use element ids that appear in the snapshot. Never invent ids or selectors.
3. Take the smallest useful step. Re-read the snapshot after each action instead of assuming.
4. If the goal is already satisfied, set "done": true, put the result in "answer", and omit "action" or use {"type":"done"}.
5. If something fails, try an alternative (scroll to reveal, pick another element, dismiss a cookie banner) before giving up. After two failures in a row, set "done": true and explain the blocker in "answer".
6. Never type passwords, card numbers, one-time codes, or other secrets unless the user's goal explicitly provides them.
7. Never navigate to non-http(s) URLs, and never claim an action succeeded without evidence in the snapshot.
8. Keep "thought" under 25 words and "plan" under 6 short items.`;
}

function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatElement(element) {
  const parts = [`#${element.id}`, element.tag || 'element'];
  if (element.type && element.tag === 'input') parts.push(`[${element.type}]`);
  if (element.role && element.role !== element.tag) parts.push(`role=${element.role}`);
  if (element.label) parts.push(`"${clip(element.label, 90)}"`);
  else if (element.placeholder) parts.push(`placeholder="${clip(element.placeholder, 60)}"`);
  if (element.value && element.tag !== 'button') parts.push(`value="${clip(element.value, 40)}"`);
  if (element.href) parts.push(`-> ${clip(element.href, 80)}`);
  if (element.checked) parts.push('(checked)');
  if (element.disabled) parts.push('(disabled)');
  if (element.inViewport === false) parts.push('(offscreen)');
  return parts.join(' ');
}

export function formatSnapshot(snapshot) {
  if (!snapshot) return 'No page snapshot available.';
  const lines = [];
  lines.push(`URL: ${clip(snapshot.url, 200)}`);
  lines.push(`TITLE: ${clip(snapshot.title, 140) || '(untitled)'}`);

  if (snapshot.scroll) {
    lines.push(
      `SCROLL: y=${Math.round(snapshot.scroll.y)} of ${Math.round(snapshot.scroll.height)}`,
    );
  }

  const elements = Array.isArray(snapshot.elements) ? snapshot.elements.slice(0, MAX_ELEMENTS) : [];
  if (elements.length) {
    lines.push('', `INTERACTIVE ELEMENTS (${elements.length} shown):`);
    for (const element of elements) lines.push(`  ${formatElement(element)}`);
  } else {
    lines.push('', 'INTERACTIVE ELEMENTS: none detected.');
  }

  if (Array.isArray(snapshot.headings) && snapshot.headings.length) {
    lines.push('', 'HEADINGS:');
    for (const heading of snapshot.headings.slice(0, 8)) lines.push(`  - ${clip(heading, 100)}`);
  }

  if (snapshot.text) {
    lines.push('', 'PAGE TEXT (truncated):', clip(snapshot.text, MAX_PAGE_TEXT));
  }
  if (Array.isArray(snapshot.iframes) && snapshot.iframes.length) {
    lines.push('', 'IFRAMES (content not accessible):');
    for (const frame of snapshot.iframes.slice(0, 5)) {
      lines.push(`  - ${clip(frame.title || frame.src || 'iframe', 100)}`);
    }
  }
  if (snapshot.truncatedElements) {
    lines.push('', `(${snapshot.truncatedElements} more elements were not shown; scroll to see them.)`);
  }
  return lines.join('\n');
}

export function formatHistory(history = []) {
  if (!Array.isArray(history) || !history.length) return 'None yet.';
  const lines = [];
  for (const entry of history.slice(-5)) {
    const action = entry.action ? describeAction(entry.action) : '(no action)';
    const status = entry.ok === false ? 'FAILED' : 'ok';
    const observation = clip(entry.observation || entry.result || '', 220);
    lines.push(`${entry.step}. ${action} [${status}]${observation ? ` → ${observation}` : ''}`);
    if (entry.error) lines.push(`   error: ${clip(entry.error, 180)}`);
  }
  return lines.join('\n');
}

export function describeAction(action) {
  if (!action || typeof action !== 'object') return 'none';
  switch (action.type) {
    case 'click':
      return `click #${action.elementId}`;
    case 'type':
      return `type ${JSON.stringify(clip(action.text, 60))} into #${action.elementId}${action.submit ? ' + Enter' : ''}`;
    case 'select':
      return `select ${JSON.stringify(clip(String(action.value), 40))} on #${action.elementId}`;
    case 'key':
      return `press ${action.key}`;
    case 'scroll':
      return `scroll ${action.direction || 'down'} ${action.amount || 600}px`;
    case 'navigate':
      return `navigate ${clip(action.url, 80)}`;
    case 'back':
      return 'browser back';
    case 'wait':
      return `wait ${action.ms || 500}ms`;
    case 'extract':
      return action.elementId ? `extract from #${action.elementId}` : 'extract from page';
    case 'done':
      return 'finish';
    default:
      return String(action.type || 'unknown action');
  }
}

export function buildUserPrompt({ goal, snapshot, history, step, maxSteps, note }) {
  const sections = [
    `GOAL: ${clip(goal, 800)}`,
    '',
    `STEP ${step} of ${maxSteps}`,
    '',
    'CURRENT PAGE SNAPSHOT:',
    formatSnapshot(snapshot),
    '',
    'YOUR PREVIOUS STEPS:',
    formatHistory(history),
  ];
  if (note) sections.push('', `IMPORTANT: ${note}`);
  sections.push('', 'Reply with the single JSON object for the next action.');
  return sections.join('\n');
}

export function buildRepairPrompt({ errors, previous }) {
  return `Your previous reply could not be used.
Problems: ${errors.join('; ')}
Previous reply (truncated): ${clip(previous, 500)}
Reply again with ONE valid JSON object only — no markdown, and only element ids that exist in the snapshot.`;
}

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  let source = text.trim();
  if (!source) return null;

  // Prefer fenced blocks when present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fence && fence[1]) source = fence[1].trim();

  const tryParse = (candidate) => {
    try {
      const value = JSON.parse(candidate);
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(source);
  if (direct) return direct;

  // Scan for the first balanced {...} object, respecting strings/escapes.
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, i + 1);
        const parsed = tryParse(candidate);
        if (parsed) return parsed;
        // Keep scanning; a later object may be valid.
        const next = source.indexOf('{', i + 1);
        if (next === -1) return null;
        i = next - 1;
        depth = 0;
        inString = false;
        escaped = false;
      }
    }
  }
  return null;
}

function toElementId(value, validIds) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return validIds.has(value) ? value : null;
  }
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^#/, '');
    if (/^\d+$/.test(cleaned)) {
      const n = Number(cleaned);
      return validIds.has(n) ? n : null;
    }
  }
  return null;
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validate + sanitise a parsed agent response against the snapshot.
 *
 * @returns {{ok:true, response:object} | {ok:false, errors:string[]}}
 */
export function validateAgentResponse(raw, snapshot) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['The reply was not a JSON object.'] };
  }

  const elementIds = new Set(
    Array.isArray(snapshot?.elements) ? snapshot.elements.map((el) => el.id) : [],
  );

  const thought = clip(typeof raw.thought === 'string' ? raw.thought : '', 300);
  const plan = Array.isArray(raw.plan)
    ? raw.plan.filter((item) => typeof item === 'string').slice(0, 6).map((item) => clip(item, 140))
    : [];
  const answer = clip(typeof raw.answer === 'string' ? raw.answer : '', 1200);
  const done = raw.done === true;
  const rawAction = raw.action && typeof raw.action === 'object' && !Array.isArray(raw.action) ? raw.action : null;

  let action = null;
  if (done && !rawAction) {
    action = { type: 'done' };
  } else if (!rawAction) {
    errors.push('No "action" object was provided and "done" is not true.');
  } else {
    const type = typeof rawAction.type === 'string' ? rawAction.type.trim().toLowerCase() : '';
    if (!ACTION_TYPES.includes(type)) {
      errors.push(`Unknown action type "${type}".`);
    } else {
      switch (type) {
        case 'click': {
          const elementId = toElementId(rawAction.elementId, elementIds);
          if (elementId === null) errors.push('click needs a valid elementId from the snapshot.');
          else action = { type, elementId };
          break;
        }
        case 'type': {
          const elementId = toElementId(rawAction.elementId, elementIds);
          const text = typeof rawAction.text === 'string' ? rawAction.text.slice(0, MAX_TEXT_LENGTH) : null;
          if (elementId === null) errors.push('type needs a valid elementId from the snapshot.');
          if (text === null) errors.push('type needs a "text" string.');
          if (elementId !== null && text !== null) {
            action = {
              type,
              elementId,
              text,
              submit: rawAction.submit === true,
              clear: rawAction.clear !== false,
            };
          }
          break;
        }
        case 'select': {
          const elementId = toElementId(rawAction.elementId, elementIds);
          const value =
            typeof rawAction.value === 'string' || typeof rawAction.value === 'number'
              ? String(rawAction.value).slice(0, 200)
              : null;
          if (elementId === null) errors.push('select needs a valid elementId from the snapshot.');
          if (value === null) errors.push('select needs a "value".');
          if (elementId !== null && value !== null) action = { type, elementId, value };
          break;
        }
        case 'key': {
          const key = typeof rawAction.key === 'string' ? rawAction.key : '';
          if (!KEY_ALLOWLIST.has(key)) errors.push(`Unsupported key "${key}".`);
          else action = { type, key };
          break;
        }
        case 'scroll': {
          const direction = rawAction.direction === 'up' ? 'up' : 'down';
          const amount = Number(rawAction.amount);
          action = {
            type,
            direction,
            amount: Number.isFinite(amount) ? Math.min(4000, Math.max(50, Math.round(amount))) : 600,
          };
          break;
        }
        case 'navigate': {
          if (!isHttpUrl(rawAction.url)) errors.push('navigate needs an http(s) URL.');
          else action = { type, url: rawAction.url.trim().slice(0, 2000) };
          break;
        }
        case 'back':
          action = { type };
          break;
        case 'wait': {
          const ms = Number(rawAction.ms);
          action = {
            type,
            ms: Number.isFinite(ms) ? Math.min(5000, Math.max(100, Math.round(ms))) : 600,
          };
          break;
        }
        case 'extract': {
          const elementId =
            rawAction.elementId === undefined || rawAction.elementId === null
              ? undefined
              : toElementId(rawAction.elementId, elementIds);
          if (rawAction.elementId !== undefined && rawAction.elementId !== null && elementId === null) {
            errors.push('extract elementId is not in the snapshot.');
          } else {
            action = {
              type,
              ...(elementId === undefined ? {} : { elementId }),
              what: clip(typeof rawAction.what === 'string' ? rawAction.what : '', 160),
            };
          }
          break;
        }
        case 'done':
          action = { type };
          break;
        default:
          errors.push('Unsupported action.');
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    response: {
      thought,
      plan,
      answer,
      done: done || action.type === 'done',
      action: action.type === 'done' ? null : action,
    },
  };
}

/** Parse + validate in one step. */
export function parseAgentReply(text, snapshot) {
  const json = extractJson(text);
  if (!json) {
    return { ok: false, errors: ['The reply did not contain a JSON object.'], raw: text };
  }
  const validated = validateAgentResponse(json, snapshot);
  return { ...validated, raw: text, json };
}
