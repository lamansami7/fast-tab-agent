/**
 * Independent provider configuration storage.
 *
 * Each provider lives under its own chrome.storage.local key
 * (`fta.provider.<id>`) and a small index (`fta.providers.index`) tracks the
 * order and which provider is active. Consequences:
 *
 *  - saving provider A never rewrites provider B (no shared blob to corrupt);
 *  - switching the active provider does not touch any provider record, so
 *    API keys and custom model ids survive switching;
 *  - a malformed single record is dropped without taking the others with it.
 *
 * The store also migrates older/foreign layouts (`providers: [...]`,
 * `activeProviderId`, or flat `apiKey`/`model`/`baseUrl` keys) exactly once and
 * never throws on corrupt storage.
 */

import { LIMITS, PROVIDER_ID_RE, STORAGE_KEYS, STORAGE_VERSION } from './constants.js';
import { createProvider, isValidProviderId, normalizeProvider } from './providers.js';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !PROVIDER_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {{get:Function,set:Function,remove:Function}} area chrome.storage area
 * @param {{now?:() => number}} [options]
 */
export function createProviderStore(area, options = {}) {
  if (!area || typeof area.get !== 'function') {
    throw new Error('createProviderStore needs a chrome.storage area');
  }
  const now = options.now || (() => Date.now());
  let queue = Promise.resolve();
  let initPromise = null;

  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read(keys) {
    try {
      const result = await area.get(keys);
      return isPlainObject(result) ? result : {};
    } catch {
      return {};
    }
  }

  async function readIndex() {
    const bag = await read([STORAGE_KEYS.index]);
    const raw = bag[STORAGE_KEYS.index];
    if (!isPlainObject(raw)) return null;
    const ids = uniqueIds(Array.isArray(raw.ids) ? raw.ids : []);
    const activeId =
      typeof raw.activeId === 'string' && ids.includes(raw.activeId)
        ? raw.activeId
        : ids[0] || null;
    return { v: STORAGE_VERSION, ids, activeId, updatedAt: Number(raw.updatedAt) || now() };
  }

  async function writeIndex(index) {
    const safe = {
      v: STORAGE_VERSION,
      ids: uniqueIds(index.ids),
      activeId:
        typeof index.activeId === 'string' && index.ids.includes(index.activeId)
          ? index.activeId
          : null,
      updatedAt: now(),
    };
    await area.set({ [STORAGE_KEYS.index]: safe });
    return safe;
  }

  async function readProvider(id) {
    if (!isValidProviderId(id)) return null;
    const key = `${STORAGE_KEYS.providerPrefix}${id}`;
    const bag = await read([key]);
    const raw = bag[key];
    if (!isPlainObject(raw)) return null;
    const normalized = normalizeProvider({ ...raw, id });
    return normalized && normalized.id === id ? normalized : null;
  }

  async function writeProvider(provider) {
    const key = `${STORAGE_KEYS.providerPrefix}${provider.id}`;
    await area.set({ [key]: provider });
    return provider;
  }

  /**
   * Read every provider plus the active id. Corrupt records are skipped, and
   * the index is repaired when it references missing providers.
   *
   * Repair runs under the write lock and re-checks each dangling id, so a
   * provider saved concurrently is never dropped from the index.
   */
  async function list(depth = 0) {
    const index = await readIndex();
    if (!index) return { providers: [], activeId: null, needsInit: true, ids: [] };

    const keys = index.ids.map((id) => `${STORAGE_KEYS.providerPrefix}${id}`);
    const bag = keys.length ? await read(keys) : {};
    const providers = [];
    const keptIds = [];
    const missing = new Set();

    for (const id of index.ids) {
      const raw = bag[`${STORAGE_KEYS.providerPrefix}${id}`];
      const normalized = isPlainObject(raw) ? normalizeProvider({ ...raw, id }) : null;
      if (!normalized || normalized.id !== id) {
        missing.add(id);
        continue;
      }
      providers.push(normalized);
      keptIds.push(id);
    }

    if (missing.size) {
      await serialize(async () => {
        const current = (await readIndex()) || { ids: [], activeId: null };
        const keep = [];
        for (const id of current.ids) {
          if (missing.has(id) && !(await readProvider(id))) continue;
          keep.push(id);
        }
        if (keep.length !== current.ids.length) {
          await writeIndex({
            ids: keep,
            activeId: keep.includes(current.activeId) ? current.activeId : keep[0] || null,
          });
        }
      });
      if (depth < 2) return list(depth + 1);
    }

    const activeId = keptIds.includes(index.activeId) ? index.activeId : keptIds[0] || null;
    return { providers, activeId, needsInit: false, ids: keptIds };
  }

  async function getActive() {
    const { providers, activeId } = await list();
    if (!providers.length) return null;
    return providers.find((p) => p.id === activeId) || providers[0] || null;
  }

  async function getById(id) {
    return readProvider(id);
  }

  /** Insert or update one provider. Returns the stored record. */
  async function save(input) {
    return serialize(async () => {
      const provider = normalizeProvider(input);
      if (!provider) throw new Error('That provider configuration could not be read.');

      let index = await readIndex();
      if (!index) index = { v: STORAGE_VERSION, ids: [], activeId: null, updatedAt: now() };

      if (!index.ids.includes(provider.id)) {
        if (index.ids.length >= LIMITS.providerCount) {
          throw new Error(`You can keep up to ${LIMITS.providerCount} provider configurations.`);
        }
        if (await readProvider(provider.id)) {
          // Extremely unlikely, but never allow two configs to share an id.
          provider.id = createProvider(provider.presetId || null).id;
        }
        provider.createdAt = provider.createdAt || now();
        index.ids.push(provider.id);
      }

      provider.updatedAt = now();
      await writeProvider(provider);
      const nextIndex = await writeIndex({
        ids: index.ids,
        activeId: index.activeId || provider.id,
      });
      return { provider, activeId: nextIndex.activeId };
    });
  }

  async function remove(id) {
    return serialize(async () => {
      if (!isValidProviderId(id)) return { removed: false, activeId: null };
      const index = (await readIndex()) || { ids: [], activeId: null };
      const ids = index.ids.filter((item) => item !== id);
      try {
        await area.remove(`${STORAGE_KEYS.providerPrefix}${id}`);
      } catch {
        /* keep going: the index is what makes a record visible */
      }
      const activeId = index.activeId === id ? ids[0] || null : index.activeId;
      await writeIndex({ ids, activeId });
      return { removed: true, activeId };
    });
  }

  async function setActive(id) {
    return serialize(async () => {
      const index = await readIndex();
      if (!index || !index.ids.includes(id)) throw new Error('That provider no longer exists.');
      await writeIndex({ ids: index.ids, activeId: id });
      return { activeId: id };
    });
  }

  /**
   * First run: create the storage index and seed one editable starting point.
   * Never overwrites or re-seeds after the user deletes everything.
   */
  function ensureInitialised() {
    if (!initPromise) {
      initPromise = initialise().catch((error) => {
        initPromise = null; // allow a later retry
        throw error;
      });
    }
    return initPromise;
  }

  async function initialise() {
    const existing = await readIndex();
    if (existing) {
      if (!existing.ids.includes(existing.activeId) && existing.ids.length) {
        await writeIndex({ ids: existing.ids, activeId: existing.ids[0] });
      }
      return;
    }

    const migrated = await migrateLegacy();
    if (migrated) return;

    const starter = createProvider('nvidia');
    await writeProvider(starter);
    await writeIndex({ ids: [starter.id], activeId: starter.id });
    const bag = await read([STORAGE_KEYS.meta]);
    await area.set({
      [STORAGE_KEYS.meta]: {
        ...(isPlainObject(bag[STORAGE_KEYS.meta]) ? bag[STORAGE_KEYS.meta] : {}),
        seededAt: now(),
        storageVersion: STORAGE_VERSION,
      },
    });
  }

  /**
   * Import legacy shapes once. Accepts:
   *   { providers: [ {...} ], activeProviderId }
   *   { provider: {...} } / flat { apiKey, model, baseUrl, providerName }
   */
  async function migrateLegacy() {
    const legacyKeys = [
      'providers',
      'activeProviderId',
      'provider',
      'activeProvider',
      'apiKey',
      'model',
      'baseUrl',
      'providerType',
      'providerName',
      STORAGE_KEYS.meta,
    ];
    const bag = await read(legacyKeys);

    const candidates = [];
    if (Array.isArray(bag.providers)) candidates.push(...bag.providers);
    if (isPlainObject(bag.provider)) candidates.push(bag.provider);
    if (isPlainObject(bag.activeProvider)) candidates.push(bag.activeProvider);
    if (isPlainObject(bag[STORAGE_KEYS.meta]) && Array.isArray(bag[STORAGE_KEYS.meta].providers)) {
      candidates.push(...bag[STORAGE_KEYS.meta].providers);
    }
    if (!candidates.length && (bag.apiKey || bag.model || bag.baseUrl)) {
      candidates.push({
        name: bag.providerName || 'Imported provider',
        baseUrl: bag.baseUrl,
        apiKey: bag.apiKey,
        model: bag.model,
      });
    }
    if (!candidates.length) return false;

    const ids = [];
    const normalized = [];
    for (const candidate of candidates.slice(0, LIMITS.providerCount)) {
      const provider = normalizeProvider(candidate);
      if (!provider) continue;
      if (ids.includes(provider.id)) provider.id = createProvider(provider.presetId || null).id;
      ids.push(provider.id);
      normalized.push(provider);
    }
    if (!normalized.length) return false;

    for (const provider of normalized) await writeProvider(provider);
    const activeCandidateRaw =
      typeof bag.activeProviderId === 'string' ? bag.activeProviderId : null;
    const activeCandidate = normalized.find((p) => p.id === activeCandidateRaw) || normalized[0];
    await writeIndex({ ids, activeId: activeCandidate.id });

    try {
      await area.remove([
        'providers',
        'activeProviderId',
        'provider',
        'activeProvider',
        'apiKey',
        'model',
        'baseUrl',
        'providerType',
        'providerName',
      ]);
    } catch {
      /* legacy cleanup is best effort */
    }
    return true;
  }

  async function count() {
    const index = await readIndex();
    return index ? index.ids.length : 0;
  }

  async function clearAll() {
    return serialize(async () => {
      const index = await readIndex();
      const keys = (index ? index.ids : []).map((id) => `${STORAGE_KEYS.providerPrefix}${id}`);
      if (keys.length) await area.remove(keys);
      await writeIndex({ ids: [], activeId: null });
      return { removed: keys.length };
    });
  }

  return {
    list,
    getActive,
    getById,
    save,
    remove,
    setActive,
    ensureInitialised,
    migrateLegacy,
    count,
    clearAll,
    readIndex,
  };
}
