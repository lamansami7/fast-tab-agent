import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseInitialTabId,
  classifyInjectionError,
  classifyTabUrl,
  filterTabs,
  isHttpUrl,
  originPatternFor,
  sortTabsForPicker,
  tabHost,
  tabTitleFor,
} from '../src/lib/tabs.js';

test('normal web pages are supported', () => {
  for (const url of ['https://example.com/a?b=1#c', 'http://localhost:3000/app']) {
    const check = classifyTabUrl(url);
    assert.equal(check.supported, true, url);
    assert.equal(check.code, 'ok');
    assert.equal(check.reason, '');
    assert.equal(isHttpUrl(url), true);
  }
});

test('Chrome internal and browser pages are explained, not crashed on', () => {
  const chromePage = classifyTabUrl('chrome://settings');
  assert.equal(chromePage.supported, false);
  assert.equal(chromePage.code, 'restricted_scheme');
  assert.match(chromePage.reason, /Chrome internal pages/i);

  for (const url of ['chrome-extension://abc/popup.html', 'about:blank', 'devtools://devtools/x', 'view-source:https://a.test']) {
    assert.equal(classifyTabUrl(url).supported, false, url);
  }
});

test('the Chrome Web Store is restricted because Chrome blocks extensions there', () => {
  for (const url of ['https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/category/extensions']) {
    const check = classifyTabUrl(url);
    assert.equal(check.supported, false, url);
    assert.equal(check.code, 'web_store');
    assert.match(check.reason, /Chrome Web Store/i);
  }
});

test('PDF and local file pages get specific, actionable reasons', () => {
  const pdf = classifyTabUrl('https://example.com/report.pdf');
  assert.equal(pdf.supported, false);
  assert.equal(pdf.code, 'pdf');
  assert.match(pdf.reason, /PDF/i);

  const file = classifyTabUrl('file:///etc/hosts');
  assert.equal(file.supported, false);
  assert.equal(file.code, 'file');
  assert.match(file.reason, /file URLs/i);
});

test('missing, malformed and unsupported URLs fail closed', () => {
  assert.equal(classifyTabUrl('').code, 'no_url');
  assert.equal(classifyTabUrl(null).code, 'no_url');
  assert.equal(classifyTabUrl('not a url').code, 'malformed');
  assert.equal(classifyTabUrl('javascript:alert(1)').supported, false);
  assert.equal(classifyTabUrl('ftp://example.com/file').code, 'restricted_scheme');
});

test('injection failures are explained as restricted, gone or unpermitted', () => {
  const chromePage = classifyInjectionError('Cannot access a chrome:// URL');
  assert.equal(chromePage.code, 'tab_restricted');
  assert.match(chromePage.hint, /normal website/i);

  const store = classifyInjectionError(
    'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
  );
  assert.equal(store.code, 'tab_permission_required');
  assert.match(store.hint, /Grant website access/i);

  const closed = classifyInjectionError('No tab with id: 42');
  assert.equal(closed.code, 'tab_unavailable');

  const unexpected = classifyInjectionError('Error in invocation of scripting.executeScript');
  assert.equal(unexpected.code, 'tab_unavailable');
  assert.match(unexpected.message, /could not start/i);
  assert.equal(classifyInjectionError(undefined).code, 'tab_unavailable');
});

test('origin patterns cover only http(s) hosts', () => {
  assert.equal(originPatternFor('https://example.com/a/b?q=1'), 'https://example.com/*');
  assert.equal(originPatternFor('http://localhost:3000/'), 'http://localhost/*');
  assert.equal(originPatternFor('chrome://settings'), null);
  assert.equal(originPatternFor('file:///tmp/a.html'), null);
  assert.equal(originPatternFor(''), null);
  assert.equal(originPatternFor(null), null);
});

test('tab titles and hosts are safe fallbacks', () => {
  assert.equal(tabTitleFor({ title: '  My page  ' }), 'My page');
  assert.equal(tabTitleFor({}), 'Untitled tab');
  assert.equal(tabHost('https://example.com:8443/path'), 'example.com:8443');
  assert.equal(tabHost('not a url'), '');
});

test('tab filtering matches title and host, case-insensitively', () => {
  const tabs = [
    { id: 1, title: 'GitHub — Pull requests', url: 'https://github.com/pulls' },
    { id: 2, title: 'Docs', url: 'https://docs.example.org/guide' },
    { id: 3, title: 'Untitled tab', url: '' },
  ];
  assert.equal(filterTabs(tabs, '').length, 3);
  assert.deepEqual(filterTabs(tabs, 'GITHUB').map((tab) => tab.id), [1]);
  assert.deepEqual(filterTabs(tabs, 'example.org').map((tab) => tab.id), [2]);
  assert.equal(filterTabs(tabs, 'nothing-here').length, 0);
  assert.equal(filterTabs(null, 'x').length, 0);
});

test('the default tab avoids restricted browser pages', () => {
  const tabs = [
    { id: 1, title: 'Docs', url: 'https://docs.example.org/guide', supported: true, restricted: false },
    { id: 2, title: 'Extensions', url: 'chrome://extensions', supported: false, restricted: true },
    { id: 3, title: 'Shop', url: 'https://shop.example.com', supported: true, restricted: false },
  ];
  assert.equal(chooseInitialTabId(tabs, 2), 1);
  assert.equal(chooseInitialTabId(tabs, 1), 1);
  assert.equal(chooseInitialTabId(tabs, null), 1);
  assert.equal(
    chooseInitialTabId([{ id: 9, url: 'chrome://settings', supported: false, restricted: true }], 9),
    9,
  );
  assert.equal(chooseInitialTabId([], null), null);
});

test('the picker puts the selected tab first, then the active tab', () => {
  const tabs = [
    { id: 1, index: 0 },
    { id: 2, index: 1 },
    { id: 3, index: 2 },
  ];
  const sorted = sortTabsForPicker(tabs, { activeTabId: 2, selectedTabId: 3 });
  assert.deepEqual(sorted.map((tab) => tab.id), [3, 2, 1]);
  assert.deepEqual(tabs.map((tab) => tab.id), [1, 2, 3], 'input is not mutated');
});
