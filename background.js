// Background service worker: routes messages between the popup, the content scripts and the offscreen
// audio-capture document, remembers per-tab subtitle state (so a reload keeps the subtitles) and runs
// subtitle-file translations in batches.

import { translateTexts } from './lib/providers.js';
import { getSettings, isLocalUrl } from './lib/settings.js';
import { hashString } from './lib/subtitles.js';

const OFFSCREEN_URL = 'offscreen.html';
const TRANSLATE_BATCH = 25;
const TRANSLATE_CONCURRENCY = 2;
const MAX_CACHED_FILES = 20;

let creatingOffscreen = null;
const translating = new Set(); // tab ids with a translation in progress

const tabKey = (tabId) => `tab:${tabId}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await chrome.storage.session.remove(tabKey(tabId));
  const { live } = await chrome.storage.session.get('live');
  if (live && live.tabId === tabId) stopLive().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || (msg.target && msg.target !== 'background')) return;
  const handler = HANDLERS[msg.type];
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (r) => sendResponse(r === undefined ? { ok: true } : r),
      (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
    );
  return true; // async response
});

const HANDLERS = {
  'content:hello': hello,
  'cues:set': setCues,
  'cues:clear': (msg, sender) => clearCues(msg.tabId ?? sender.tab?.id),
  'cues:translate': (msg) => startTranslation(msg.tabId),
  'delay:set': setDelay,
  'live:start': startLive,
  'live:stop': stopLive,
  'live:status': liveStatus,
  'live:cue': (msg) => sendToTab(msg.tabId, { type: 'live-cue', cue: msg.cue }),
  'live:state': onLiveState,
};

// ---------------------------------------------------------------- per-tab state

async function getTab(tabId) {
  const r = await chrome.storage.session.get(tabKey(tabId));
  return r[tabKey(tabId)] || null;
}

async function putTab(tabId, data) {
  await chrome.storage.session.set({ [tabKey(tabId)]: data });
}

async function sendToTab(tabId, msg) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, msg); // reaches every frame of the tab
  } catch {
    /* no content script in this tab (yet) */
  }
}

function samePage(a, b) {
  try {
    const u = new URL(a);
    const v = new URL(b);
    return u.origin === v.origin && u.pathname === v.pathname && u.search === v.search;
  } catch {
    return a === b;
  }
}

/** A content script started (page load / reload): give it back whatever this tab already had. */
async function hello(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: true };
  const { live } = await chrome.storage.session.get('live');
  const liveHere = !!(live && live.tabId === tabId && (await hasOffscreen()));
  const t = await getTab(tabId);
  if (!t) return { ok: true, live: liveHere };
  const pageUrl = sender.tab?.url || msg.url || '';
  if (t.url && pageUrl && !samePage(t.url, pageUrl)) {
    await chrome.storage.session.remove(tabKey(tabId)); // the tab moved to another page
    return { ok: true, live: liveHere };
  }
  return { ok: true, cues: t.cues || [], name: t.name || '', delay: t.delay || 0, live: liveHere };
}

async function setCues({ tabId, url, cues, name }) {
  if (tabId == null || !Array.isArray(cues)) throw new Error('Bad request');
  const prev = await getTab(tabId);
  const t = { url: url || prev?.url || '', name: name || '', cues, delay: prev?.delay || 0 };
  await putTab(tabId, t);
  await sendToTab(tabId, { type: 'set-cues', cues, name: t.name });
  return { ok: true, count: cues.length };
}

async function clearCues(tabId) {
  if (tabId == null) return;
  await chrome.storage.session.remove(tabKey(tabId));
  await sendToTab(tabId, { type: 'clear' });
}

async function setDelay({ tabId, delay }) {
  const t = await getTab(tabId);
  if (t) {
    t.delay = Number(delay) || 0;
    await putTab(tabId, t);
  }
  await sendToTab(tabId, { type: 'set-delay', delay: Number(delay) || 0 });
}

// ---------------------------------------------------------------- subtitle-file translation

async function startTranslation(tabId) {
  if (tabId == null) throw new Error('No tab');
  if (translating.has(tabId)) return { ok: true, already: true };
  const t = await getTab(tabId);
  if (!t || !t.cues?.length) throw new Error('Load a subtitle file first');
  const settings = await getSettings();
  if (!settings.anthropicKey && !settings.openaiKey && !isLocalUrl(settings.openaiBaseUrl)) {
    throw new Error('Add an Anthropic or OpenAI API key in Options');
  }
  translating.add(tabId);
  runTranslation(tabId, t, settings)
    .catch((e) => progress(tabId, { done: true, error: e?.message || String(e) }))
    .finally(() => translating.delete(tabId));
  return { ok: true };
}

async function runTranslation(tabId, t, settings) {
  // An extension API call every 20 s keeps the service worker alive for the duration of the job.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const originals = t.cues.map((c) => c.original || c.text);
    const source = settings.sourceLang || 'auto';
    const target = settings.targetLang || 'en';
    const cacheKey = `tr:${source}:${target}:${hashString(originals.join('\n'))}`;
    const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
    let translated;

    if (Array.isArray(cached) && cached.length === originals.length) {
      translated = cached;
    } else {
      progress(tabId, { done: false, count: 0, total: originals.length });
      translated = new Array(originals.length).fill('');
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < originals.length) {
          const start = next;
          next += TRANSLATE_BATCH;
          const batch = originals.slice(start, start + TRANSLATE_BATCH);
          const context = originals.slice(Math.max(0, start - 4), start).map((o) => ({ original: o, text: '' }));
          const out = await translateTexts(batch, { settings, source, target, context });
          const texts = out.map((s, i) => s || batch[i]);
          texts.forEach((s, i) => {
            translated[start + i] = s;
          });
          done += batch.length;
          await sendToTab(tabId, { type: 'patch-cues', index: start, texts, originals: batch });
          progress(tabId, { done: false, count: done, total: originals.length });
        }
      };
      await Promise.all(Array.from({ length: TRANSLATE_CONCURRENCY }, worker));
      await rememberTranslation(cacheKey, translated);
    }

    const fresh = await getTab(tabId);
    if (fresh && fresh.cues?.length === originals.length) {
      fresh.cues = fresh.cues.map((c, i) => ({ ...c, text: translated[i] || c.text, original: originals[i] }));
      await putTab(tabId, fresh);
      await sendToTab(tabId, { type: 'set-cues', cues: fresh.cues, name: fresh.name });
    }
    progress(tabId, { done: true, count: originals.length, total: originals.length });
  } finally {
    clearInterval(keepAlive);
  }
}

async function rememberTranslation(cacheKey, translated) {
  const { trIndex = [] } = await chrome.storage.local.get('trIndex');
  const index = [cacheKey, ...trIndex.filter((k) => k !== cacheKey)];
  const stale = index.slice(MAX_CACHED_FILES);
  await chrome.storage.local.set({ [cacheKey]: translated, trIndex: index.slice(0, MAX_CACHED_FILES) });
  if (stale.length) await chrome.storage.local.remove(stale);
}

function progress(tabId, p) {
  chrome.runtime.sendMessage({ target: 'popup', type: 'translate:progress', tabId, ...p }).catch(() => {});
  const text = p.error
    ? `Translation failed: ${p.error}`
    : p.done
      ? 'Translation finished'
      : `Translating… ${p.count}/${p.total}`;
  sendToTab(tabId, { type: 'status', text, level: p.error ? 'error' : 'info', ttl: p.done ? 4000 : 90000 });
}

// ---------------------------------------------------------------- live subtitles (offscreen document)

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Capture the tab audio to generate live subtitles',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

/** Message the offscreen document, retrying briefly while it is still loading. */
async function askOffscreen(msg, retries = 15) {
  for (let i = 0; i < retries; i++) {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => undefined);
    if (r !== undefined) return r;
    await sleep(100);
  }
  return undefined;
}

async function startLive({ tabId, streamId, url }) {
  if (tabId == null || !streamId) throw new Error('Bad request');
  const settings = await getSettings(); // offscreen documents cannot read chrome.storage themselves
  await ensureOffscreen();
  const r = await askOffscreen({ type: 'start', streamId, tabId, settings });
  if (!r || !r.ok) throw new Error(r?.error || 'Could not start audio capture');
  await chrome.storage.session.set({ live: { tabId, url: url || '', startedAt: Date.now() } });
  const t = (await getTab(tabId)) || { url: url || '', name: '', cues: [], delay: 0 };
  if (!t.url) t.url = url || '';
  await putTab(tabId, t);
  await sendToTab(tabId, { type: 'live-state', state: 'listening' });
  return { ok: true };
}

async function stopLive() {
  const { live } = await chrome.storage.session.get('live');
  if (await hasOffscreen()) {
    await askOffscreen({ type: 'stop' }, 3);
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  await chrome.storage.session.remove('live');
  if (live) await sendToTab(live.tabId, { type: 'live-state', state: 'stopped' });
  return { ok: true };
}

async function liveStatus() {
  if (!(await hasOffscreen())) return { running: false };
  const r = await askOffscreen({ type: 'status' }, 3);
  return r || { running: false };
}

async function onLiveState({ tabId, state, detail }) {
  if (tabId != null) await sendToTab(tabId, { type: 'live-state', state, detail });
  if (state === 'stopped' || state === 'ended') {
    await chrome.storage.session.remove('live');
    if (state === 'ended' && (await hasOffscreen())) chrome.offscreen.closeDocument().catch(() => {});
  }
}
