import test from 'node:test';
import assert from 'node:assert/strict';

// A stand-in for chrome.storage.local, enough for lib/settings.js.
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: structuredClone(store[key]) } : {}),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
    },
  },
};
const { getSettings, saveSettings, migrateSettings, DEFAULTS, SETTINGS_VERSION } = await import('../lib/settings.js');

test('new installs get the fast segmenting defaults and draft lines', async () => {
  delete store.settings;
  const s = await getSettings();
  assert.equal(s.minSegSec, 1);
  assert.equal(s.maxSegSec, 3.5);
  assert.equal(s.silenceMs, 350);
  assert.equal(s.draftLines, true);
  assert.equal(store.settings, undefined, 'nothing is written for a fresh install');
});

test('settings saved by version 1 (which stored every default) move to the new defaults', async () => {
  store.settings = { ...DEFAULTS, minSegSec: 1.5, maxSegSec: 7, silenceMs: 600, engine: 'local', fontScale: 6 };
  delete store.settings.settingsVersion;
  const s = await getSettings();
  assert.deepEqual([s.minSegSec, s.maxSegSec, s.silenceMs], [1, 3.5, 350]);
  assert.equal(s.fontScale, 6, 'other choices are kept');
  assert.equal(store.settings.settingsVersion, SETTINGS_VERSION, 'the migration is saved');
  assert.equal('maxSegSec' in store.settings, false);
});

test('values the user changed in version 1 are kept', () => {
  const m = migrateSettings({ minSegSec: 2, maxSegSec: 5, silenceMs: 600 });
  assert.equal(m.minSegSec, 2);
  assert.equal(m.maxSegSec, 5);
  assert.equal('silenceMs' in m, false, 'still the old default, so it moves');
});

test("saving stores only the user's values, so later default changes reach them", async () => {
  delete store.settings;
  await saveSettings({ fontScale: 5 });
  assert.deepEqual(Object.keys(store.settings).sort(), ['fontScale', 'settingsVersion']);
  const again = migrateSettings({ settingsVersion: 2, maxSegSec: 7 });
  assert.equal(again.maxSegSec, 7, 'a version 2 choice of 7 s is respected');
});
