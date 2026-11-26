/**
 * Fast Tab Agent — page agent (content script).
 *
 * Injected on demand by the background worker. Responsibilities:
 *   - produce a compact, stable snapshot of the page for the model;
 *   - perform one validated action at a time;
 *   - show a small status pill while a task runs.
 *
 * It never sees provider configuration or API keys: only goal text, action
 * objects and page content flow through this script.
 */
(function () {
  // Re-injection after an extension reload must register a fresh listener. The
  // old isolated world is dead, so compare the runtime id instead of trusting
  // a bare boolean flag that would block the new script forever.
  let runtimeId = '';
  try {
    runtimeId = typeof chrome !== 'undefined' && chrome.runtime ? chrome.runtime.id || '' : '';
  } catch {
    runtimeId = '';
  }
  if (window.__ftaAgentLoaded === true && window.__ftaAgentRuntimeId === runtimeId) return;
  window.__ftaAgentLoaded = true;
  window.__ftaAgentRuntimeId = runtimeId;

  // Bounded so a huge page cannot produce an unbounded snapshot payload.
  const MAX_ELEMENTS = 160;
  const documentToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let observedTargets = new Map();
  let observedFocus = null;

  function targetSignature(el) {
    return JSON.stringify([el.tagName, elementLabel(el), el.type, el.role,
      el.getAttribute('href'), el.form?.action, el.getAttribute('formaction'), el.getAttribute('name')]);
  }
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="searchbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[onclick]',
  ].join(',');

  /** Stable ids across snapshots, so history references stay meaningful. */
  let nextId = 1;
  const idByElement = new WeakMap();
  const elementById = new Map();

  function stableId(el) {
    let id = idByElement.get(el);
    if (!id) {
      id = nextId++;
      idByElement.set(el, id);
      elementById.set(id, el);
    }
    return id;
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    for (let node = el; node && node instanceof Element; node = node.parentElement) {
      if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert') || node.hidden) return false;
      let style;
      try {
        style = window.getComputedStyle(node);
      } catch {
        return false;
      }
      if (!style || style.visibility === 'hidden' || style.display === 'none') return false;
      if (style.opacity !== '' && Number(style.opacity) === 0) return false;
    }
    if (el.getAttribute('aria-modal') === 'false') return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function inViewport(rect) {
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth
    );
  }

  const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number']);
  const SENSITIVE_FIELD_RE = /password|passcode|one.?time|verification|auth(?:entication)?|secret|token|credit.?card|card.?number|cvc|cvv|security.?code|ssn|social.?security|bank.?account|account.?number|date.?of.?birth|birth.?date|email|phone|address/i;
  // A narrower list: these fields are never typed into automatically, even if
  // the user's request seems to ask for it. Ordinary contact fields (email,
  // phone, address) remain available for form filling.
  const SECRET_FIELD_RE = /password|passcode|one.?time|\botp\b|verification.?code|auth(?:entication)?.?code|\bsecret\b|credit.?card|card.?number|cvc|cvv|security.?code|ssn|social.?security/i;
  const HIGH_IMPACT_RE = /\b(buy|purchase|pay|checkout|place order|submit order|delete|remove|send|publish|post|transfer|withdraw|book|booking|reservation|subscribe|unsubscribe|cancel (?:order|booking|reservation|subscription)|sign out|log out|reset)\b/i;

  function isSensitiveField(el) {
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
    const autocomplete = el.getAttribute('autocomplete') || '';
    const metadata = [
      el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
      el.getAttribute('placeholder'), autocomplete,
    ].filter(Boolean).join(' ');
    return SENSITIVE_FIELD_RE.test(metadata);
  }

  function isSecretField(el) {
    if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^(cc-|one-time-code$|current-password$|new-password$)/.test(autocomplete)) return true;
    const metadata = [
      el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
      el.getAttribute('placeholder'), autocomplete,
    ].filter(Boolean).join(' ');
    return SECRET_FIELD_RE.test(metadata);
  }

  function elementLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .join(' ')
        .trim();
      if (parts) return parts;
    }

    if (el.labels && el.labels.length) {
      const text = Array.from(el.labels)
        .map((label) => label.innerText || '')
        .join(' ')
        .trim();
      if (text) return text;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        if (el.value) return el.value;
      }
      if (el.placeholder) return el.placeholder;
    }
    if (tag === 'textarea' && el.placeholder) return el.placeholder;

    const inner = (el.innerText || el.textContent || '').trim();
    if (inner && inner.length <= 140) return inner;
    if (inner) return inner.slice(0, 140);

    if (el.title) return el.title;
    if (tag === 'img' && el.alt) return el.alt;
    if (el.getAttribute('name')) return el.getAttribute('name');
    if (el.id) return el.id;
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    return '';
  }

  function describeElement(el) {
    const tag = el.tagName.toLowerCase();
    const label = elementLabel(el).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!label) return `<${tag}>`;
    return `${tag} "${label}"`;
  }

  function isNestedInInteractive(el, collected) {
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      if (collected.has(parent)) return true;
      parent = parent.parentElement;
      depth += 1;
    }
    return false;
  }

  function isMeaningful(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.hasAttribute('contenteditable')) return true;
    if (tag === 'button' || tag === 'a' || tag === 'summary') return true;
    return Boolean(el.getAttribute('aria-label') || el.getAttribute('title'));
  }

  function snapshot() {
    // Release detached dynamic-page nodes; otherwise each re-render would keep
    // old DOM subtrees alive for the lifetime of this content-script document.
    for (const [id, element] of elementById) {
      if (!element.isConnected) elementById.delete(id);
    }
    const nodes = document.querySelectorAll(SELECTOR);
    const visible = [], offscreen = [];
    for (const el of nodes) {
      (inViewport(el.getBoundingClientRect()) ? visible : offscreen).push(el);
    }
    observedTargets = new Map();
    observedFocus = document.activeElement;
    const collected = new Set();
    const entries = [];
    let total = 0;

    for (const el of [...visible, ...offscreen]) {
      if (entries.length >= MAX_ELEMENTS) { total += 1; continue; }
      if (el.closest('[data-fta-root]')) continue;
      // Content hidden from assistive tech (or inert) is not actionable.
      if (el.closest('[aria-hidden="true"]')) continue;
      if (el.closest('[inert]')) continue;
      // Password controls are not exposed to the model at all.
      if (el instanceof HTMLInputElement && el.type === 'password') continue;
      if (!isMeaningful(el)) continue;
      if (!isVisible(el)) continue;
      if (isNestedInInteractive(el, collected)) continue;
      total += 1;

      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      const entry = {
        id: stableId(el),
        tag,
        type: type || undefined,
        role: el.getAttribute('role') || undefined,
        label: elementLabel(el).replace(/\s+/g, ' ').trim().slice(0, 160) || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        value:
          (tag === 'input' || tag === 'textarea' || tag === 'select') && !isSensitiveField(el) && !isSecretField(el)
            ? String(el.value ?? '').slice(0, 80)
            : undefined,
        sensitive: isSensitiveField(el) || undefined,
        secret: isSecretField(el) || undefined,
        href: tag === 'a' ? String(el.getAttribute('href') || '').slice(0, 300) : undefined,
        checked: typeof el.checked === 'boolean' && ['checkbox', 'radio'].includes(type) ? el.checked : undefined,
        options: tag === 'select' ? Array.from(el.options).filter(optionEnabled).slice(0, 14)
          .map((option) => option.text.trim().slice(0, 80)) : undefined,
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' ? true : undefined,
        contenteditable: el.isContentEditable || undefined,
        inViewport: inViewport(rect),
      };
      // Drop empty synthetic fields to keep the prompt small.
      for (const key of Object.keys(entry)) {
        if (entry[key] === undefined || entry[key] === '') delete entry[key];
      }
      entries.push(entry);
      observedTargets.set(entry.id, targetSignature(el));
      collected.add(el);
    }

    // Show what the user can actually see first.
    entries.sort((a, b) => Number(b.inViewport === true) - Number(a.inViewport === true));

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter(isVisible)
      .slice(0, 10)
      .map((h) => (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140))
      .filter(Boolean);

    let text = '';
    try {
      text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4200);
    } catch {
      text = '';
    }

    const iframes = Array.from(document.querySelectorAll('iframe'))
      .slice(0, 5)
      .map((frame) => ({
        src: (frame.getAttribute('src') || '').slice(0, 200),
        title: (frame.getAttribute('title') || '').slice(0, 120),
      }))
      .filter((frame) => frame.src || frame.title);

    return {
      url: location.href,
      context: { documentToken, url: location.href },
      title: document.title,
      scroll: {
        y: window.scrollY,
        height: Math.max(
          document.documentElement?.scrollHeight || 0,
          document.body?.scrollHeight || 0,
        ),
        viewport: window.innerHeight,
      },
      elements: entries,
      headings,
      text,
      iframes,
      truncatedElements: Math.max(0, total - entries.length),
      capturedAt: Date.now(),
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function highlight(el) {
    try {
      const rect = el.getBoundingClientRect();
      const ring = document.createElement('div');
      ring.setAttribute('data-fta-root', 'highlight');
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${Math.max(0, rect.left - 3)}px`,
        top: `${Math.max(0, rect.top - 3)}px`,
        width: `${Math.min(window.innerWidth, rect.width + 6)}px`,
        height: `${Math.min(window.innerHeight, rect.height + 6)}px`,
        border: '2px solid #7c5cff',
        borderRadius: '8px',
        boxShadow: '0 0 0 4px rgba(124,92,255,0.18)',
        pointerEvents: 'none',
        zIndex: '2147483646',
        transition: 'opacity 220ms ease',
        opacity: '1',
      });
      document.documentElement.appendChild(ring);
      setTimeout(() => {
        ring.style.opacity = '0';
        setTimeout(() => ring.remove(), 260);
      }, 520);
    } catch {
      /* highlighting is cosmetic */
    }
  }

  function resolveElement(elementId) {
    const el = elementById.get(Number(elementId));
    if (!el || !el.isConnected || !isVisible(el) || observedTargets.get(Number(elementId)) !== targetSignature(el)) return null;
    return el;
  }

  function isDisabled(el) {
    return Boolean(
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.closest('fieldset[disabled]'),
    );
  }

  function isSafeLink(el) {
    if (!(el instanceof HTMLAnchorElement)) return true;
    const href = el.getAttribute('href');
    if (!href || href.startsWith('#')) return true;
    try {
      const url = new URL(href, location.href);
      return !url.username && !url.password && ['http:', 'https:'].includes(url.protocol);
    } catch {
      return false;
    }
  }

  function hasHighImpactContext(el) {
    const link = el.closest('a[href]');
    if (link && (link.origin !== location.origin || link.hasAttribute('download') || (link.target && link.target !== '_self'))) return true;
    const description = `${elementLabel(el)} ${el.getAttribute('name') || ''} ${el.getAttribute('aria-label') || ''}`;
    if (HIGH_IMPACT_RE.test(description)) return true;
    const form = el.form || el.closest('form');
    if (form && (el.type === 'submit' || form.method.toLowerCase() === 'post' ||
        new URL(form.action, location.href).origin !== location.origin)) return true;
    if (!form) return false;
    const formText = `${form.innerText || form.textContent || ''} ${form.getAttribute('action') || ''}`;
    return HIGH_IMPACT_RE.test(formText.slice(0, 2000));
  }

  function confirmHighImpact(description) {
    try {
      return window.confirm(`Fast Tab Agent is about to ${description}. Continue?`);
    } catch {
      return false;
    }
  }

  function humanClick(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      /* scrollIntoView is best effort */
    }
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint?.(x, y);
    if (typeof document.elementFromPoint === 'function' && (!hit || !el.contains(hit))) return false;
    highlight(el);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };
    const dispatch = (type, extra = {}) => {
      const Ctor = type.startsWith('pointer') ? window.PointerEvent || window.MouseEvent : window.MouseEvent;
      try {
        el.dispatchEvent(new Ctor(type, { ...base, ...extra }));
      } catch {
        /* older engines */
      }
    };
    try {
      el.focus({ preventScroll: true });
    } catch {
      /* not focusable */
    }
    dispatch('pointerover', { pointerType: 'mouse', isPrimary: true });
    dispatch('pointerenter', { pointerType: 'mouse', isPrimary: true });
    dispatch('mousedown', { buttons: 1 });
    dispatch('mouseup');
    if (typeof el.click === 'function') {
      el.click();
    } else {
      dispatch('click');
    }
    return true;
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : null;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  }

  function focusElement(el) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    highlight(el);
  }

  function typeInto(el, text, { clear = true } = {}) {
    let expected;
    focusElement(el);
    const tag = el.tagName.toLowerCase();

    if (el.isContentEditable) {
      if (clear) el.textContent = '';
      expected = el.textContent + text;
      el.textContent = expected;
      el.dispatchEvent(
        new InputEvent('input', { bubbles: true, cancelable: true, data: text, inputType: 'insertText' }),
      );
    } else if (tag === 'select') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Unidentified' }));
      let next = clear ? text : `${el.value || ''}${text}`;
      if (el.maxLength > 0) next = next.slice(0, el.maxLength);
      expected = next;
      setNativeValue(el, next);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    }

    return expected;
  }

  function optionEnabled(option) {
    return !option.disabled && !option.closest('optgroup[disabled]');
  }

  function pressKey(target, key) {
    const el = target || document.activeElement || document.body;
    const init = { key, code: key, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function executeAction(action) {
    if (!action || typeof action !== 'object') {
      return { ok: false, observation: 'No action was provided.' };
    }

    switch (action.type) {
      case 'click': {
        const el = resolveElement(action.elementId);
        if (!el) return { ok: false, observation: `Element #${action.elementId} is no longer visible on the page.` };
        if (isDisabled(el)) return { ok: false, observation: `${describeElement(el)} is disabled.` };
        if (isSecretField(el) || (el instanceof HTMLInputElement && el.type.toLowerCase() === 'file')) {
          return { ok: false, observation: 'Secret fields and file-upload controls cannot be operated by the agent.' };
        }
        if (!isSafeLink(el)) return { ok: false, observation: 'Links using non-http(s) schemes cannot be opened.' };
        if (hasHighImpactContext(el) && !confirmHighImpact(`activate ${describeElement(el)}`)) {
          return { ok: false, halt: true, observation: `User confirmation was not granted for ${describeElement(el)}; no action was taken.` };
        }
        const description = describeElement(el);
        const toggle = el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type);
        const priorChecked = el.checked;
        if (!humanClick(el)) {
          return { ok: false, observation: `${description} is covered or outside the visible area. Dismiss the overlay or choose another target.` };
        }
        // Return an acknowledgement promptly for links, before navigation can close the channel.
        if (!(el instanceof HTMLAnchorElement)) await sleep(300);
        if (toggle && el.isConnected) {
          const expected = el.type === 'radio' ? true : !priorChecked;
          return { ok: el.checked === expected, observation: el.checked === expected
            ? `${description} is now ${el.checked ? 'checked' : 'unchecked'}.`
            : `${description} did not retain the expected selection.` };
        }
        return { ok: true, observation: `Dispatched click on ${description}. Verify its effect on the next snapshot. Page title: "${document.title}".` };
      }
      case 'type': {
        const el = resolveElement(action.elementId);
        if (!el) return { ok: false, observation: `Element #${action.elementId} is no longer visible on the page.` };
        const tag = el.tagName.toLowerCase();
        if (isDisabled(el) || el.readOnly || el.getAttribute('aria-readonly') === 'true') return { ok: false, observation: `${describeElement(el)} cannot be edited.` };
        if (isSecretField(el)) {
          return {
            ok: false,
            observation: `${describeElement(el)} looks like a sensitive field (password, payment or verification code), so the agent will not type into it.`,
          };
        }
        if ((tag !== 'input' && tag !== 'textarea' && !el.isContentEditable) ||
            (tag === 'input' && !TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase()))) {
          return { ok: false, observation: `${describeElement(el)} is not a supported text field.` };
        }
        if (action.submit === true && hasHighImpactContext(el) && !confirmHighImpact('submit this form')) {
          return { ok: false, halt: true, observation: 'User confirmation was not granted; the form was not submitted.' };
        }
        const expected = typeInto(el, String(action.text ?? ''), { clear: action.clear !== false });
        await sleep(250);
        if (!el.isConnected || String(el.value ?? el.textContent ?? '') !== expected) {
          return { ok: false, observation: 'The field rejected, reformatted, or replaced the entered value. Inspect the current field before continuing.' };
        }
        if (action.submit) {
          if (!resolveElement(action.elementId)) return { ok: false, observation: 'The form changed after typing. Reinspect it before submitting.' };
          if (el.form && !hasHighImpactContext(el) && el.form.method.toLowerCase() === 'get') {
            if (!el.form.reportValidity()) return { ok: false, observation: 'The form contains invalid or missing fields.' };
            el.form.requestSubmit();
            return { ok: true, observation: 'Verified the field value and requested form submission. Check the next page for results.' };
          }
          pressKey(el, 'Enter');
        }
        return { ok: true, observation: `Verified text in ${describeElement(el)}${isSensitiveField(el) ? ' [value hidden]' : ''}${action.submit ? '; dispatched Enter, submission not verified' : ''}.` };
      }
      case 'select': {
        const el = resolveElement(action.elementId);
        if (!el) return { ok: false, observation: `Element #${action.elementId} is no longer visible on the page.` };
        if (el.tagName.toLowerCase() !== 'select') {
          return { ok: false, observation: `${describeElement(el)} is not a <select> element.` };
        }
        if (isDisabled(el)) return { ok: false, observation: `${describeElement(el)} is disabled.` };
        const options = Array.from(el.options || []).filter(optionEnabled);
        const wanted = String(action.value ?? '').trim().toLowerCase();
        const exact = options.filter((o) => o.value.toLowerCase() === wanted);
        const labels = options.filter((o) => o.text.trim().toLowerCase() === wanted);
        const partial = wanted ? options.filter((o) => o.text.toLowerCase().includes(wanted)) : [];
        const candidates = exact.length ? exact : labels.length ? labels : partial;
        if (candidates.length !== 1) {
          return { ok: false, observation: `${candidates.length ? 'Ambiguous option' : 'No option matched among enabled options'}. Options: ${options.slice(0, 12).map((o) => o.text.trim().slice(0, 80)).join(' | ')}` };
        }
        const [match] = candidates;
        const value = match.value;
        el.selectedIndex = match.index;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(250);
        if (!el.isConnected || el.value !== value || el.options[el.selectedIndex] !== match) return { ok: false, observation: 'The page did not retain the selected option.' };
        return { ok: true, observation: `Selected "${match.text.trim()}".` };
      }
      case 'key': {
        const active = document.activeElement;
        if (active !== observedFocus) return { ok: false, observation: 'Keyboard focus changed since the page was read. Read the page again before pressing a key.' };
        if (active instanceof Element && isSecretField(active)) {
          return { ok: false, observation: 'Keyboard actions are blocked while a password field is focused.' };
        }
        if ((action.key === 'Delete' || action.key === 'Backspace') &&
            !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.isContentEditable)) {
          return { ok: false, observation: 'Delete and Backspace are restricted to editable fields.' };
        }
        const activates = action.key === 'Enter' || action.key === ' ';
        if (activates && active && !isSafeLink(active)) {
          return { ok: false, observation: 'Links using non-http(s) schemes cannot be activated.' };
        }
        if (activates && active && hasHighImpactContext(active) &&
            !confirmHighImpact(`activate ${describeElement(active)}`)) {
          return { ok: false, halt: true, observation: 'User confirmation was not granted; the action was not activated.' };
        }
        pressKey(null, action.key);
        await sleep(300);
        return { ok: true, observation: `Pressed ${action.key}.` };
      }
      case 'scroll': {
        const amount = Number(action.amount) || 600;
        const delta = action.direction === 'up' ? -amount : amount;
        let scroller = window;
        if (action.elementId != null) {
          const anchor = resolveElement(action.elementId);
          if (!anchor) return { ok: false, observation: 'The scroll target changed. Locate it on the current page.' };
          for (let node = anchor; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
              scroller = node;
              break;
            }
          }
          if (scroller === window) return { ok: false, observation: 'No scrollable panel contains this element. Omit the target to scroll the document.' };
        }
        const position = () => scroller === window ? window.scrollY : scroller.scrollTop;
        const priorY = position();
        scroller.scrollBy({ top: delta, left: 0, behavior: 'instant' });
        await sleep(350);
        return {
          ok: position() !== priorY,
          observation: position() === priorY ? 'No scroll movement. The document or panel may be at its edge.' : `Scrolled ${scroller === window ? 'the document' : 'the panel'} to y=${Math.round(position())}.`,
        };
      }
      case 'navigate': {
        const url = String(action.url || '');
        let parsed;
        try {
          parsed = new URL(url, location.href);
        } catch {
          return { ok: false, observation: 'That URL is not valid.' };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, observation: 'Only http and https URLs can be opened.' };
        }
        if (parsed.username || parsed.password) return { ok: false, observation: 'URLs with embedded credentials are blocked.' };
        if (parsed.origin !== location.origin && !confirmHighImpact(`navigate from ${location.host} to ${parsed.host}`)) {
          return { ok: false, halt: true, observation: 'Cross-site navigation was not approved.' };
        }
        // Respond before navigating so the caller gets an acknowledgement.
        setTimeout(() => {
          location.assign(parsed.toString());
        }, 60);
        return { ok: true, observation: `Navigating to ${parsed.host}${parsed.pathname}` };
      }
      case 'back': {
        setTimeout(() => history.back(), 60);
        return { ok: true, observation: 'Going back to the previous page.' };
      }
      case 'wait': {
        const ms = Math.min(5000, Math.max(100, Number(action.ms) || 600));
        await sleep(ms);
        return { ok: true, observation: `Waited ${ms}ms.` };
      }
      case 'find': {
        const query = String(action.query || '').trim().replace(/\s+/g, ' ');
        if (query.length < 2 || query.length > 120) return { ok: false, observation: 'Provide a literal phrase of 2–120 characters.' };
        const raw = document.body?.innerText || '';
        const maxChars = 180_000;
        const text = raw.slice(0, maxChars).replace(/\s+/g, ' ');
        // Escape all regex metacharacters: page search is literal, not executable syntax.
        const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
        const snippets = [];
        for (const match of text.matchAll(pattern)) {
          snippets.push(text.slice(Math.max(0, match.index - 65), match.index + match[0].length + 80));
          if (snippets.length === 3) break;
        }
        const limit = raw.length > maxChars ? ' Search was limited to the first 180,000 characters.' : '';
        return { ok: true, observation: snippets.length
          ? `Rendered page excerpts: ${snippets.join(' … | … ')}${limit}`
          : `No literal match in the rendered text searched.${limit}` };
      }
      case 'extract': {
        let text = '';
        if (action.elementId !== undefined) {
          const el = resolveElement(action.elementId);
          if (!el) return { ok: false, observation: `Element #${action.elementId} is no longer on the page.` };
          if (isSecretField(el)) return { ok: false, observation: 'Secret fields cannot be extracted.' };
          text = (el.innerText || el.textContent || '').trim();
        } else {
          text = (document.body?.innerText || '').trim();
        }
        return { ok: true, observation: text.replace(/\s+/g, ' ').slice(0, 900) || '(no text)' };
      }
      case 'done':
        return { ok: true, observation: 'Task finished.' };
      default:
        return { ok: false, observation: `Unsupported action "${action.type}".` };
    }
  }

  /* ---------------------------------------------------------------- HUD -- */

  let hud = null;

  function buildHud() {
    if (hud) return hud;
    const host = document.createElement('div');
    host.setAttribute('data-fta-root', 'hud');
    Object.assign(host.style, {
      position: 'fixed',
      right: '18px',
      bottom: '18px',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .pill {
          pointer-events: auto;
          display: flex; align-items: center; gap: 10px;
          font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #e9ebf2;
          background: rgba(14, 16, 23, 0.94);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 999px;
          padding: 8px 10px 8px 12px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.45);
          backdrop-filter: blur(8px);
        }
        .spin {
          width: 12px; height: 12px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.18);
          border-top-color: #8b7bff;
          animation: r 0.8s linear infinite;
        }
        .done { width: 10px; height: 10px; border-radius: 50%; background: #2fbf71; }
        .err  { width: 10px; height: 10px; border-radius: 50%; background: #ff6b6b; }
        .text { max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .muted { color: #9aa1b4; }
        button {
          pointer-events: auto;
          font: inherit; color: #d6d9e3;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 999px; padding: 4px 10px; cursor: pointer;
        }
        button:hover { background: rgba(255,255,255,0.13); }
        @keyframes r { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
      </style>
      <div class="pill" role="status" aria-live="polite">
        <span class="ind"></span>
        <span class="text"></span>
        <button type="button" class="stop">Stop</button>
      </div>
    `;
    root.querySelector('.stop').addEventListener('click', () => {
      try {
        const pending = chrome.runtime.sendMessage({ type: 'task:stop', source: 'hud' });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* extension was reloaded */
      }
      updateHud({ running: false, label: 'Stopping…' });
    });
    document.documentElement.appendChild(host);
    hud = { host, root };
    return hud;
  }

  function updateHud({ running = true, label = '', step = 0, maxSteps = 0, tone = 'running' }) {
    const { root, host } = buildHud();
    host.style.display = '';
    const indicator = root.querySelector('.ind');
    // Keep the stable `ind` hook so the next update can find it again.
    indicator.className = `ind ${running ? 'spin' : tone === 'error' ? 'err' : 'done'}`;
    root.querySelector('.text').textContent = running
      ? `Fast Tab Agent${step ? ` · step ${step}${maxSteps ? `/${maxSteps}` : ''}` : ''}`
      : label || 'Fast Tab Agent';
    root.querySelector('.stop').style.display = running ? '' : 'none';
    if (!running && tone !== 'running') {
      setTimeout(() => {
        host.style.display = 'none';
      }, 3600);
    }
  }

  function hideHud() {
    if (hud && hud.host.parentNode) hud.host.parentNode.removeChild(hud.host);
    hud = null;
  }

  /* --------------------------------------------------------- messaging -- */

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case 'fta:ping':
        sendResponse({ ok: true, url: location.href, context: { documentToken } });
        return false;
      case 'fta:snapshot':
        if (document.readyState === 'loading' && !document.body) {
          sendResponse({ ok: false, retryable: true, error: 'The page is still loading.' });
          return false;
        }
        try {
          sendResponse({ ok: true, snapshot: snapshot() });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || 'Snapshot failed.' });
        }
        return false;
      case 'fta:execute':
        if (!message.context || message.context.documentToken !== documentToken || message.context.url !== location.href) {
          sendResponse({ ok: false, observation: 'The page changed since it was read. Use a fresh snapshot before interacting.' });
          return false;
        }
        executeAction(message.action)
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({ ok: false, observation: error?.message || 'Action failed.' }),
          );
        return true;
      case 'fta:hud':
        try {
          if (message.hide) hideHud();
          else updateHud(message.state || {});
        } catch {
          /* cosmetic */
        }
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
