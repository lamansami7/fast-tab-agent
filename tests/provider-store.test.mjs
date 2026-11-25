import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderStore } from '../src/lib/provider-store.js';
import { createProvider, normalizeProvider } from '../src/lib/providers.js';
import { STORAGE_KEYS } from '../src/lib/constants.js';
import { createStorageArea } from './helpers.mjs';

function makeStore(area) {
  let clock = 1_700_000_000_000;
  return createProviderStore(area, { now: () => (clock += 1000) });
}

test('first run seeds one editable starter provider', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const { providers, activeId } = await store.list();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, 'NVIDIA NIM');
  assert.equal(activeId, providers[0].id);
  assert.ok(area.dump()[`${STORAGE_KEYS.providerPrefix}${providers[0].id}`]);
});

test('each provider is stored under its own key and switching preserves every field', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const groq = createProvider('groq');
  groq.apiKey = 'gsk_first';
  groq.model = 'custom-model-one';
  const savedA = await store.save(groq);

  const custom = createProvider(null);
  custom.name = 'My proxy';
  custom.baseUrl = 'https://proxy.example.com/v1';
  custom.apiKey = 'proxy-key';
  custom.model = 'proxy-model';
  const savedB = await store.save(custom);

  const keys = Object.keys(area.dump());
  assert.ok(keys.includes(`${STORAGE_KEYS.providerPrefix}${savedA.provider.id}`));
  assert.ok(keys.includes(`${STORAGE_KEYS.providerPrefix}${savedB.provider.id}`));

  await store.setActive(savedA.provider.id);
  const afterSwitch = await store.list();
  assert.equal(afterSwitch.activeId, savedA.provider.id);
  const a = afterSwitch.providers.find((p) => p.id === savedA.provider.id);
  const b = afterSwitch.providers.find((p) => p.id === savedB.provider.id);
  assert.equal(a.apiKey, 'gsk_first');
  assert.equal(a.model, 'custom-model-one');
  assert.equal(b.apiKey, 'proxy-key');
  assert.equal(b.model, 'proxy-model');
});

test('two configurations of the same preset stay independent', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const first = createProvider('openai');
  first.apiKey = 'sk-one';
  first.model = 'gpt-4o-mini';
  const savedFirst = await store.save(first);

  const second = createProvider('openai');
  second.name = 'OpenAI (work)';
  second.apiKey = 'sk-two';
  second.model = 'gpt-4.1';
  const savedSecond = await store.save(second);

  assert.notEqual(savedFirst.provider.id, savedSecond.provider.id);
  const { providers } = await store.list();
  const a = providers.find((p) => p.id === savedFirst.provider.id);
  const b = providers.find((p) => p.id === savedSecond.provider.id);
  assert.equal(a.apiKey, 'sk-one');
  assert.equal(b.apiKey, 'sk-two');
  assert.equal(b.model, 'gpt-4.1');
  assert.equal(a.model, 'gpt-4o-mini');
});

test('deleting the active provider promotes another one', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const a = (await store.save(createProvider('groq'))).provider;
  const b = (await store.save(createProvider('mistral'))).provider;
  await store.setActive(a.id);

  const result = await store.remove(a.id);
  assert.equal(result.removed, true);
  const { providers, activeId } = await store.list();
  assert.equal(providers.length, 2); // the seeded starter + b
  assert.equal(providers.some((p) => p.id === a.id), false);
  assert.equal(providers.some((p) => p.id === b.id), true);
  assert.equal(activeId, providers[0].id); // first remaining provider takes over
  assert.equal(area.dump()[`${STORAGE_KEYS.providerPrefix}${a.id}`], undefined);
});

test('malformed records are skipped and the index is repaired', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();
  const good = (await store.save(createProvider('openai'))).provider;

  // Corrupt the stored record.
  await area.set({ [`${STORAGE_KEYS.providerPrefix}${good.id}`]: 'not-an-object' });

  const { providers } = await store.list();
  assert.equal(providers.find((p) => p.id === good.id), undefined);
  const index = area.dump()[STORAGE_KEYS.index];
  assert.equal(index.ids.includes(good.id), false);
});

test('corrupt index falls back to a clean initialisation', async () => {
  const area = createStorageArea({ [STORAGE_KEYS.index]: 'garbage' });
  const store = makeStore(area);
  await store.ensureInitialised();
  const { providers, activeId } = await store.list();
  assert.equal(providers.length, 1);
  assert.equal(activeId, providers[0].id);
});

test('an empty index is respected (no silent re-seeding)', async () => {
  const area = createStorageArea({
    [STORAGE_KEYS.index]: { v: 1, ids: [], activeId: null, updatedAt: 1 },
  });
  const store = makeStore(area);
  await store.ensureInitialised();
  const { providers } = await store.list();
  assert.deepEqual(providers, []);
});

test('legacy single-blob layouts are migrated once', async () => {
  const area = createStorageArea({
    providers: [
      {
        id: 'unique-id',
        name: 'Groq',
        type: 'preset',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk_legacy',
        model: 'llama-3.3-70b-versatile',
      },
      {
        name: 'Custom',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'legacy-key',
        model: 'legacy-model',
      },
    ],
    activeProviderId: 'unique-id',
  });
  const store = makeStore(area);
  await store.ensureInitialised();

  const { providers, activeId } = await store.list();
  assert.equal(providers.length, 2);
  assert.equal(providers[0].name, 'Groq');
  assert.equal(providers[0].apiKey, 'gsk_legacy');
  assert.equal(providers[1].name, 'Custom');
  assert.equal(activeId, providers[0].id);
  assert.equal(area.dump().providers, undefined);
  assert.equal(area.dump().activeProviderId, undefined);

  // A second init must not duplicate anything.
  const area2 = createStorageArea(area.dump());
  const store2 = makeStore(area2);
  await store2.ensureInitialised();
  assert.equal((await store2.list()).providers.length, 2);
});

test('flat legacy keys are migrated into a provider record', async () => {
  const area = createStorageArea({
    apiKey: 'old-key',
    model: 'old-model',
    baseUrl: 'https://api.deepseek.com/v1',
    providerName: 'DeepSeek',
  });
  const store = makeStore(area);
  await store.ensureInitialised();
  const { providers } = await store.list();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].apiKey, 'old-key');
  assert.equal(providers[0].model, 'old-model');
  assert.equal(providers[0].name, 'DeepSeek');
});

test('saving keeps createdAt and bumps updatedAt', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const provider = createProvider('cerebras');
  provider.createdAt = 1_600_000_000_000;
  const saved = await store.save(provider);
  assert.equal(saved.provider.createdAt, 1_600_000_000_000);
  assert.ok(saved.provider.updatedAt > provider.createdAt);

  saved.provider.model = 'changed-model';
  const updated = await store.save(saved.provider);
  assert.equal(updated.provider.createdAt, 1_600_000_000_000);
  assert.equal(updated.provider.model, 'changed-model');
});

test('concurrent saves of different providers both persist', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const a = createProvider('groq');
  const b = createProvider('together');
  const c = createProvider(null);
  c.name = 'C';
  c.baseUrl = 'https://c.example.com/v1';

  await Promise.all([store.save(a), store.save(b), store.save(c)]);
  const { providers } = await store.list();
  const ids = providers.map((p) => p.id);
  for (const provider of [a, b, c]) assert.ok(ids.includes(provider.id));
});

test('saving a provider with an id that already exists updates it', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const provider = (await store.save(createProvider('mistral'))).provider;
  provider.model = 'mistral-small-latest';
  const again = await store.save(provider);
  assert.equal(again.provider.id, provider.id);
  assert.equal((await store.list()).providers.filter((p) => p.id === provider.id).length, 1);
});

test('normalised unknown records are never written', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();
  await assert.rejects(() => store.save('nonsense'), /could not be read/i);
});

test('getById and getActive return independent copies', async () => {
  const area = createStorageArea();
  const store = makeStore(area);
  await store.ensureInitialised();

  const provider = (await store.save(createProvider('openai'))).provider;
  await store.setActive(provider.id);
  const fetched = await store.getById(provider.id);
  assert.equal(fetched.apiKey, provider.apiKey);
  fetched.apiKey = 'mutated';
  assert.equal((await store.getById(provider.id)).apiKey, provider.apiKey);
  assert.equal(normalizeProvider(fetched).id, provider.id);
  assert.equal((await store.getActive()).id, provider.id);
});
