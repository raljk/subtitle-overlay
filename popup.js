// Popup: load subtitle files, start/stop live subtitles, adjust timing and display.

import { getSettings, saveSettings, liveBlocker, engineLabel, isLocalEngine } from './lib/settings.js';
import { parseSubtitles, decodeSubtitleBytes, looksJapanese } from './lib/subtitles.js';

const $ = (id) => document.getElementById(id);
const bg = (msg) =>
  chrome.runtime.sendMessage({ target: 'background', ...msg }).catch((e) => ({ ok: false, error: e?.message || String(e) }));

let tab = null;
let settings = null;
let delay = 0;
let unsupported = false;
let lastFileInfo = null;

init().catch((e) => setText('pageStatus', `Error: ${e.message}`, 'error'));

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('tabId')) tab = await chrome.tabs.get(Number(params.get('tabId'))); // used by the test harness
  else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await getSettings();

  $('fontScale').value = settings.fontScale;
  $('bottomPct').value = settings.bottomPct;
  $('showOriginal').checked = !!settings.showOriginal;
  $('autoTranslate').checked = settings.autoTranslateFiles !== false;
  updateSliderLabels();
  wire();
  chrome.runtime.onMessage.addListener(onMessage);
  await refreshPage();
  await refreshLive();
}

function setText(id, text, cls = '') {
  const node = $(id);
  node.textContent = text || '';
  node.className = `info ${cls}`.trim();
  node.hidden = false;
}

function wire() {
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('file').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
    e.target.value = '';
  };
  const drop = $('drop');
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  };
  $('translate').onclick = () => startTranslate();
  $('clear').onclick = async () => {
    await bg({ type: 'cues:clear', tabId: tab.id });
    fileLoaded(null);
    setText('translateInfo', '');
    await refreshPage();
  };
  $('autoTranslate').onchange = (e) => saveSettings({ autoTranslateFiles: e.target.checked });
  $('liveStart').onclick = () => startLive();
  $('liveStop').onclick = () => stopLive();
  for (const b of document.querySelectorAll('[data-delay]')) b.onclick = () => setDelay(delay + Number(b.dataset.delay));
  $('delayReset').onclick = () => setDelay(0);
  $('fontScale').oninput = (e) => {
    saveDisplay({ fontScale: Number(e.target.value) });
    updateSliderLabels();
  };
  $('bottomPct').oninput = (e) => {
    saveDisplay({ bottomPct: Number(e.target.value) });
    updateSliderLabels();
  };
  $('showOriginal').onchange = (e) => saveDisplay({ showOriginal: e.target.checked });
}

let saveTimer = 0;
const pendingPatch = {};
function saveDisplay(patch) {
  Object.assign(pendingPatch, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const p = { ...pendingPatch };
    for (const k of Object.keys(pendingPatch)) delete pendingPatch[k];
    saveSettings(p);
  }, 120);
}

function updateSliderLabels() {
  $('fontScaleVal').textContent = `${Number($('fontScale').value).toFixed(2).replace(/\.?0+$/, '')}%`;
  $('bottomPctVal').textContent = `${$('bottomPct').value}%`;
}

// ---------------------------------------------------------------- page / content script

async function contentStatus() {
  try {
    return { res: await chrome.tabs.sendMessage(tab.id, { type: 'get-status' }) };
  } catch (e) {
    return { err: e };
  }
}

async function refreshPage() {
  if (!tab || !/^(https?|file):/.test(tab.url || '')) {
    unsupported = true;
    setText('pageStatus', 'Subtitles can’t run on this page (browser pages and the Web Store are off-limits).', 'warn');
    setControls(false);
    return;
  }
  let { res, err } = await contentStatus();
  if (err) {
    // The page was open before the extension was installed/reloaded: inject the content script now.
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] });
      ({ res, err } = await contentStatus());
    } catch (e) {
      err = e;
    }
  }
  if (err) {
    unsupported = true;
    setText('pageStatus', `Can’t access this page: ${err.message}`, 'warn');
    setControls(false);
    return;
  }
  unsupported = false;
  setControls(true);
  if (!res) {
    setText('pageStatus', 'No video found on this page yet. Subtitles will show up once a video is on screen.', 'muted');
    return;
  }
  delay = Number(res.delay) || 0;
  renderDelay();
  const bits = ['Video found'];
  if (res.name) bits.push(res.name);
  if (res.cueCount) bits.push(`${res.cueCount} cues${res.translated ? ' (translated)' : ''}`);
  setText('pageStatus', bits.join(' · '), 'ok');
  if (res.cueCount) {
    const known = lastFileInfo && lastFileInfo.name === res.name ? lastFileInfo : {};
    fileLoaded({ ...known, name: res.name, count: res.cueCount, translated: res.translated });
  }
}

function setControls(enabled) {
  for (const id of ['translate', 'clear', 'liveStart', 'liveStop', 'delayReset']) $(id).disabled = !enabled;
  for (const b of document.querySelectorAll('[data-delay]')) b.disabled = !enabled;
  $('file').disabled = !enabled;
}

// ---------------------------------------------------------------- subtitle files

async function loadFile(file) {
  try {
    setText('fileInfo', `Reading ${file.name}…`, 'muted');
    setText('translateInfo', '');
    const text = decodeSubtitleBytes(await file.arrayBuffer());
    const { format, cues } = parseSubtitles(text, file.name);
    if (!cues.length) throw new Error('No subtitle cues found in this file');
    const japanese = looksJapanese(cues.slice(0, 300).map((c) => c.text).join('\n'));
    const r = await bg({ type: 'cues:set', tabId: tab.id, url: tab.url, cues, name: file.name });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Could not send the subtitles to the page');
    fileLoaded({ name: file.name, count: cues.length, format, japanese });
    if (japanese && settings.autoTranslateFiles !== false) await startTranslate();
    await refreshPage();
  } catch (e) {
    setText('fileInfo', e.message, 'error');
  }
}

function fileLoaded(info) {
  lastFileInfo = info;
  if (!info) {
    $('fileInfo').hidden = true;
    $('fileActions').hidden = true;
    return;
  }
  $('fileActions').hidden = false;
  const bits = [info.name, `${info.count} cues`];
  if (info.format) bits.push(info.format.toUpperCase());
  if (info.japanese) bits.push('Japanese');
  if (info.translated) bits.push('translated');
  setText('fileInfo', bits.join(' · '));
}

async function startTranslate() {
  const r = await bg({ type: 'cues:translate', tabId: tab.id });
  if (!r || !r.ok) {
    setText('translateInfo', (r && r.error) || 'Could not start the translation', 'error');
    return;
  }
  setText('translateInfo', 'Translating… lines switch to English as each batch finishes.', 'muted');
}

// ---------------------------------------------------------------- live subtitles

async function startLive() {
  setText('liveInfo', 'Starting…', 'muted');
  try {
    const blocker = liveBlocker(settings);
    if (blocker) throw new Error(blocker);
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const r = await bg({ type: 'live:start', tabId: tab.id, streamId, url: tab.url });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Could not start');
    await refreshLive();
  } catch (e) {
    setText('liveInfo', e.message, 'error');
  }
}

async function stopLive() {
  await bg({ type: 'live:stop' });
  await refreshLive();
}

async function refreshLive() {
  renderLive(await bg({ type: 'live:status' }));
}

function renderLive(s) {
  const here = !!(s && s.running && s.tabId === tab.id);
  $('liveStart').hidden = here;
  $('liveStop').hidden = !here;
  const mode = engineLabel(settings);
  if (here) {
    const txt =
      s.state === 'error'
        ? `Error: ${s.error || 'unknown'}`
        : s.state === 'translating'
          ? 'Listening… translating a segment'
          : 'Listening to this tab';
    setText('liveInfo', `${txt} · ${mode}`, s.state === 'error' ? 'error' : 'ok');
  } else if (s && s.running) {
    setText('liveInfo', 'Live subtitles are running in another tab. Starting here moves them to this tab.', 'warn');
  } else if (liveBlocker(settings)) {
    setText('liveInfo', liveBlocker(settings), 'muted');
  } else if (isLocalEngine(settings)) {
    setText('liveInfo', `${mode}. Free and private: everything runs on this Mac. Subtitles trail the speech by a few seconds.`, 'muted');
  } else {
    setText('liveInfo', `${mode}. Audio goes to ${settings.sttModel || 'whisper-1'} a few seconds at a time. Subtitles trail the speech by a few seconds.`, 'muted');
  }
}

// ---------------------------------------------------------------- timing

async function setDelay(v) {
  delay = Math.round(v * 10) / 10;
  renderDelay();
  await bg({ type: 'delay:set', tabId: tab.id, delay });
}

function renderDelay() {
  $('delayVal').textContent = `${delay > 0 ? '+' : ''}${delay.toFixed(1)}s`;
}

// ---------------------------------------------------------------- messages from the background / offscreen

function onMessage(msg) {
  if (!msg || !tab) return;
  if (msg.type === 'translate:progress' && msg.tabId === tab.id) {
    if (msg.error) setText('translateInfo', `Translation failed: ${msg.error}`, 'error');
    else if (msg.done) {
      setText('translateInfo', 'Translation finished.', 'ok');
      refreshPage();
    } else setText('translateInfo', `Translating… ${msg.count}/${msg.total}`, 'muted');
  }
  if (msg.type === 'live:state' && msg.tabId === tab.id) {
    const running = msg.state !== 'stopped' && msg.state !== 'ended';
    renderLive({ running, tabId: tab.id, state: msg.state, error: msg.detail });
  }
}
