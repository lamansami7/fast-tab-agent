/**
 * Page agent test in a real DOM (jsdom): snapshot building, action execution,
 * safety guards and the in-page status pill.
 *
 * Requires the dev dependency: npm install && npm run test:dom
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  test('page agent (skipped — jsdom is not installed)', { skip: true }, () => {});
}

if (JSDOM) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..', '..');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test('page agent: snapshot, actions and HUD', async () => {
    const script = await readFile(join(ROOT, 'src/content/agent.js'), 'utf8');
    const dom = new JSDOM(
      `<!doctype html><html><head><title>Shop</title></head><body>
        <h1>Shop for shoes</h1>
        <form>
          <label for="q">Search shoes</label>
          <input id="q" type="search" placeholder="Search products">
          <input id="password" type="password" value="super-secret">
          <input id="email" type="email" value="person@example.com" autocomplete="email">
          <input id="otp" type="text" autocomplete="one-time-code" placeholder="Verification code">
          <button id="go" type="button">Search now</button>
        </form>
        <button id="disabled" type="button" disabled>Disabled control</button>
        <button id="delete" type="button">Delete account</button>
        <a id="link" href="/cart">Cart</a>
        <div id="panel" style="overflow-y:auto"><select id="size"><option value="s">Small</option><option value="l">Large</option></select></div>
        <button id="hidden" style="display:none">Hidden button</button>
        <div aria-hidden="true"><button id="aria">Aria hidden</button></div>
        <textarea id="notes" placeholder="Notes"></textarea>
        <iframe title="Payment frame" src="https://pay.example.com/frame"></iframe>
        <p>Prices start at $49.</p>
      </body></html>`,
      { url: 'https://shop.example.com/products', runScripts: 'outside-only', pretendToBeVisual: true },
    );
    const { window } = dom;

    // Shims for APIs jsdom does not implement.
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      get() {
        return this.textContent;
      },
      set(value) {
        this.textContent = value;
      },
      configurable: true,
    });
    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 120, height: 32, top: 20, left: 20, right: 140, bottom: 52, x: 20, y: 20 };
    };
    window.Element.prototype.scrollIntoView = function () {};
    window.scrollBy = (options) => {
      window.__scrolled = options;
    };
    Object.defineProperty(window, 'scrollY', { get: () => 0, configurable: true });
    Object.defineProperty(window, 'innerHeight', { get: () => 800, configurable: true });
    Object.defineProperty(window, 'innerWidth', { get: () => 1200, configurable: true });

    const sent = [];
    let confirmNext = false;
    const confirmationMessages = [];
    window.confirm = (message) => {
      confirmationMessages.push(message);
      return confirmNext;
    };
    window.chrome = {
      runtime: {
        id: 'test-ext',
        sendMessage: async (message) => {
          sent.push(message);
          return { ok: true };
        },
        onMessage: {
          addListener: (fn) => {
            window.__listener = fn;
          },
        },
      },
    };

    window.eval(script);
    const listener = window.__listener;
    assert.ok(listener, 'content script registered a message listener');

    let context;
    const send = (message) =>
      new Promise((resolve) => {
        let done = false;
        const sendResponse = (value) => {
          if (!done) {
            done = true;
            resolve(value);
          }
        };
        listener(message.type === 'fta:execute' ? { context, ...message } : message, {}, sendResponse);
        setTimeout(() => {
          if (!done) {
            done = true;
            resolve(undefined);
          }
        }, 2000);
      });

    // 1. ping
    const ping = await send({ type: 'fta:ping' });
    assert.equal(ping.ok, true);
    assert.equal(ping.url, 'https://shop.example.com/products');

    // 2. snapshot
    const snapshot = (await send({ type: 'fta:snapshot' })).snapshot;
    context = snapshot.context;
    assert.equal(snapshot.title, 'Shop');
    assert.ok(snapshot.elements.length >= 5);
    const byLabel = (text) => snapshot.elements.find((element) => (element.label || '').includes(text));
    const searchInput = byLabel('Search shoes') || snapshot.elements.find((element) => element.tag === 'input');
    const searchButton = byLabel('Search now');
    const cartLink = byLabel('Cart');
    const sizeSelect = snapshot.elements.find((element) => element.tag === 'select');
    assert.ok(searchInput && searchInput.type === 'search');
    assert.ok(searchButton);
    assert.ok(cartLink && cartLink.href === '/cart');
    assert.ok(sizeSelect);
    assert.ok(snapshot.elements.some((element) => element.placeholder === 'Notes'));
    assert.equal(snapshot.elements.some((element) => element.label === 'Hidden button'), false);
    assert.equal(snapshot.elements.some((element) => element.label === 'Aria hidden'), false);
    assert.equal(snapshot.elements.some((element) => element.type === 'password'), false);
    const emailField = snapshot.elements.find((element) => element.type === 'email');
    assert.ok(emailField?.sensitive);
    assert.equal(emailField.value, undefined);
    const otpField = snapshot.elements.find((element) => element.placeholder === 'Verification code');
    assert.ok(otpField, 'verification code fields are visible in the snapshot');
    assert.equal(otpField.secret, true, 'one-time-code fields are marked secret');
    assert.equal(otpField.value, undefined);
    assert.equal(snapshot.text.includes('super-secret'), false);
    for (const element of snapshot.elements) assert.equal(typeof element.id, 'number');
    assert.ok(snapshot.headings.includes('Shop for shoes'));
    assert.ok(snapshot.iframes.some((frame) => frame.title === 'Payment frame'));
    assert.ok(snapshot.text.includes('Prices start at $49'));

    // stable ids across snapshots
    const again = (await send({ type: 'fta:snapshot' })).snapshot;
    assert.equal(again.elements.find((element) => element.label === 'Search now').id, searchButton.id);

    // 3. click dispatches exactly one click
    let clicks = 0;
    window.document.getElementById('go').addEventListener('click', () => {
      clicks += 1;
    });
    const clickResult = await send({
      type: 'fta:execute',
      action: { type: 'click', elementId: searchButton.id },
    });
    assert.equal(clickResult.ok, true);
    assert.equal(clicks, 1);
    assert.match(clickResult.observation, /Dispatched click/);

    const staleDocument = await send({ type: 'fta:execute', context: { ...context, documentToken: 'other' }, action: { type: 'click', elementId: searchButton.id } });
    assert.equal(staleDocument.ok, false);
    const button = window.document.getElementById('go');
    window.document.elementFromPoint = () => window.document.body;
    const covered = await send({ type: 'fta:execute', action: { type: 'click', elementId: searchButton.id } });
    assert.match(covered.observation, /covered/);
    delete window.document.elementFromPoint;
    button.textContent = 'Replaced meaning';
    const staleTarget = await send({ type: 'fta:execute', action: { type: 'click', elementId: searchButton.id } });
    assert.equal(staleTarget.ok, false);
    button.textContent = 'Search now';
    assert.equal(clicks, 1);

    const disabledId = byLabel('Disabled control').id;
    const disabledResult = await send({
      type: 'fta:execute',
      action: { type: 'click', elementId: disabledId },
    });
    assert.equal(disabledResult.ok, false);
    assert.match(disabledResult.observation, /disabled/i);

    let deleteClicks = 0;
    window.document.getElementById('delete').addEventListener('click', () => { deleteClicks += 1; });
    const deleteId = byLabel('Delete account').id;
    const cancelledDelete = await send({ type: 'fta:execute', action: { type: 'click', elementId: deleteId } });
    assert.equal(cancelledDelete.ok, false);
    assert.equal(deleteClicks, 0, 'declining confirmation prevents the destructive click');
    assert.match(confirmationMessages.at(-1), /Delete account/);
    confirmNext = true;
    const confirmedDelete = await send({ type: 'fta:execute', action: { type: 'click', elementId: deleteId } });
    assert.equal(confirmedDelete.ok, true);
    assert.equal(deleteClicks, 1);

    // 4. typing (framework-friendly events, append mode, submit)
    let inputEvents = 0;
    window.document.getElementById('q').addEventListener('input', () => {
      inputEvents += 1;
    });
    const typeResult = await send({
      type: 'fta:execute',
      action: { type: 'type', elementId: searchInput.id, text: 'running shoes' },
    });
    assert.equal(typeResult.ok, true);
    assert.equal(window.document.getElementById('q').value, 'running shoes');
    assert.ok(inputEvents >= 1);
    await send({
      type: 'fta:execute',
      action: { type: 'type', elementId: searchInput.id, text: ' red', clear: false },
    });
    assert.equal(window.document.getElementById('q').value, 'running shoes red');

    const form = window.document.querySelector('form');
    let submissions = 0;
    form.addEventListener('submit', (event) => { event.preventDefault(); submissions += 1; });
    const submitted = await send({ type: 'fta:execute', action: { type: 'type', elementId: searchInput.id, text: 'trail shoes', submit: true } });
    assert.equal(submitted.ok, true);
    assert.equal(submissions, 1, 'low-impact GET forms use native submission');

    // Ordinary contact fields remain fillable, but their value is not echoed.
    const emailType = await send({
      type: 'fta:execute',
      action: { type: 'type', elementId: emailField.id, text: 'new@example.com' },
    });
    assert.equal(emailType.ok, true);
    assert.equal(window.document.getElementById('email').value, 'new@example.com');
    assert.match(emailType.observation, /\[value hidden\]/);

    // Passwords, payment fields and one-time codes are never typed into.
    const otpType = await send({
      type: 'fta:execute',
      action: { type: 'type', elementId: otpField.id, text: '123456' },
    });
    assert.equal(otpType.ok, false);
    assert.match(otpType.observation, /sensitive field/i);
    assert.equal(window.document.getElementById('otp').value, '');

    const q = window.document.getElementById('q');
    q.addEventListener('input', () => { q.value = ''; }, { once: true });
    const rejected = await send({ type: 'fta:execute', action: { type: 'type', elementId: searchInput.id, text: 'rejected input' } });
    assert.equal(rejected.ok, false);
    assert.match(rejected.observation, /rejected/);

    // 5. select by visible text
    const selectResult = await send({
      type: 'fta:execute',
      action: { type: 'select', elementId: sizeSelect.id, value: 'large' },
    });
    assert.equal(selectResult.ok, true);
    assert.equal(window.document.getElementById('size').value, 'l');
    const badSelect = await send({
      type: 'fta:execute',
      action: { type: 'select', elementId: sizeSelect.id, value: 'huge' },
    });
    assert.equal(badSelect.ok, false);
    assert.match(badSelect.observation, /No option matched/);

    // 6. extract
    const extractResult = await send({
      type: 'fta:execute',
      action: { type: 'extract', elementId: cartLink.id },
    });
    assert.equal(extractResult.observation, 'Cart');

    const panel = window.document.getElementById('panel');
    Object.defineProperties(panel, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } });
    panel.scrollBy = ({ top }) => { panel.scrollTop += top; };
    const panelScroll = await send({ type: 'fta:execute', action: { type: 'scroll', elementId: sizeSelect.id, amount: 200 } });
    assert.equal(panelScroll.ok, true);
    assert.equal(panel.scrollTop, 200);

    // 7. scroll + wait
    await send({ type: 'fta:execute', action: { type: 'scroll', direction: 'down', amount: 500 } });
    assert.equal(window.__scrolled.top, 500);
    assert.equal((await send({ type: 'fta:execute', action: { type: 'wait', ms: 100 } })).ok, true);

    // 8. unsafe navigation and stale ids fail cleanly
    const navResult = await send({
      type: 'fta:execute',
      action: { type: 'navigate', url: 'javascript:alert(1)' },
    });
    assert.equal(navResult.ok, false);
    assert.match(navResult.observation, /http/i);

    const missing = await send({ type: 'fta:execute', action: { type: 'click', elementId: 99999 } });
    assert.equal(missing.ok, false);
    assert.match(missing.observation, /no longer visible on the page/);

    // 9. HUD updates repeatedly (regression: indicator class must stay stable)
    await send({ type: 'fta:hud', state: { running: true, step: 2, maxSteps: 8 } });
    const host = window.document.querySelector('[data-fta-root="hud"]');
    assert.ok(host);
    assert.match(host.shadowRoot.textContent, /step 2\/8/);
    await send({ type: 'fta:hud', state: { running: true, step: 3, maxSteps: 8 } });
    assert.match(host.shadowRoot.textContent, /step 3\/8/, 'HUD updates after the first render');
    host.shadowRoot.querySelector('.stop').click();
    await delay(30);
    assert.ok(sent.some((message) => message.type === 'task:stop'));
    await send({ type: 'fta:hud', state: { running: false, label: 'done', tone: 'done' } });
    assert.equal(host.shadowRoot.querySelector('.stop').style.display, 'none');
    assert.match(host.shadowRoot.textContent, /done/);
  });
}
