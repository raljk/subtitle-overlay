// End-to-end check of the unpacked extension in Chromium via Playwright, against mock engines.
// Covers: content-script injection, popup → background → overlay for a Japanese .srt, automatic batch
// translation through the local (Ollama) engine, delay control, state restore after reload, fullscreen,
// clear, the live-start error path, and the Origin rule that lets a stock Ollama accept the extension.
//
// Usage: node test/e2e.mjs            (needs `npm i -D playwright` in this folder, or PLAYWRIGHT_DIR=<project with playwright>)
//        HEADED=1 node test/e2e.mjs   (watch it run)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from './mock-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.PLAYWRIGHT_DIR ? path.join(process.env.PLAYWRIGHT_DIR, 'package.json') : path.join(root, 'package.json'));
const { chromium } = require('playwright');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.mp4': 'video/mp4', '.srt': 'text/plain; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
function startStatic() {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    // Chromium only treats media as seekable when the server honours byte-range requests.
    const size = fs.statSync(file).size;
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function waitFor(fn, { timeout = 10000, every = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
// Seek once the metadata is loaded (a seek issued before that is dropped) and wait for it to take effect.
const seekTo = (page, t) =>
  page.evaluate(async (t) => {
    const v = document.getElementById('v');
    v.pause();
    if (v.readyState < 1) await new Promise((r) => v.addEventListener('loadedmetadata', r, { once: true }));
    v.currentTime = t;
    if (Math.abs(v.currentTime - t) > 0.01) await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    return v.currentTime;
  }, t);
// Text currently drawn in the overlay (runs in the page's main world; the host element is in the light DOM).
const overlayText = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-subtitle-overlay]');
    const cue = host && host.shadowRoot && host.shadowRoot.querySelector('.cue');
    return cue ? cue.textContent : null;
  });
const overlayStatus = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('[data-subtitle-overlay]');
    const s = host && host.shadowRoot && host.shadowRoot.querySelector('.status');
    return s ? s.textContent : null;
  });

const mock = await startMockApi();
const site = await startStatic();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-overlay-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: !process.env.HEADED,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});

try {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('service worker started', !!extId, extId);

  const localSettings = {
    engine: 'local',
    localSpeechUrl: mock.baseUrl,
    localSpeechModel: 'mlx-community/Mega-ASR-bf16',
    ollamaUrl: mock.origin,
    ollamaModel: 'qwen3:8b',
    autoTranslateFiles: true,
    sourceLang: 'ja',
    targetLang: 'en',
  };
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), localSettings);

  const pageUrl = `${site.origin}/test/page.html`;
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.waitForSelector('#v');
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, pageUrl);
  check('video tab found by the service worker', typeof tabId === 'number', `tabId ${tabId}`);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(`page: ${e.message}`));
  const popup = await context.newPage();
  popup.on('pageerror', (e) => pageErrors.push(`popup: ${e.message}`));
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  const status = await waitFor(async () => {
    const t = await popup.locator('#pageStatus').textContent();
    return t && !/Checking/.test(t) ? t : null;
  });
  check('popup detects the video', /Video found/.test(status || ''), status);

  // Load the Japanese .srt → cues reach the overlay; the mock API translates them in batches.
  await popup.setInputFiles('#file', path.join(root, 'test', 'fixtures', 'sample.ja.srt'));
  const fileInfo = await waitFor(async () => {
    const t = await popup.locator('#fileInfo').textContent();
    return /cues/.test(t || '') ? t : null;
  });
  check('popup parsed the file', /6 cues · SRT · Japanese/.test(fileInfo || ''), fileInfo);

  await page.bringToFront(); // the overlay renders on animation frames, which pause in background tabs
  check('video seeks to 2 s', (await seekTo(page, 2)) === 2);
  const english = await waitFor(async () => {
    const t = await overlayText(page);
    return t && /EN: こんにちは、世界。/.test(t) ? t : null;
  });
  check('overlay shows the translated first cue at t=2 s', !!english, english || (await overlayText(page)));
  const chat = mock.calls.find((c) => c.url === '/api/chat');
  check('translation went through Ollama with no API key', !!chat && chat.batch === 6 && chat.think === false, JSON.stringify(chat));
  check('the extension dropped its Origin header on Ollama requests', chat && chat.origin === null, `origin: ${chat && chat.origin}`);
  const translateInfo = await waitFor(async () => {
    const t = await popup.locator('#translateInfo').textContent();
    return /finished/.test(t || '') ? t : null;
  });
  check('popup reports the translation finished', !!translateInfo, translateInfo);

  // Bilingual display comes from the display settings (storage → content script).
  await popup.bringToFront();
  await popup.check('#showOriginal');
  await page.bringToFront();
  const bilingual = await waitFor(async () => {
    const t = await overlayText(page);
    return t && /こんにちは、世界。.*EN: こんにちは、世界。/s.test(t) ? t : null;
  });
  check('bilingual display shows original + English', !!bilingual, bilingual);

  // Time-based lookup: at 4.3 s cue 1 (1–4 s) is gone; with +0.5 s delay it is still showing.
  await seekTo(page, 4.3);
  const gone = await waitFor(async () => ((await overlayText(page)) === '' ? 'empty' : null));
  check('cue hides after its end time', gone === 'empty');
  await popup.bringToFront();
  await popup.click('[data-delay="0.5"]');
  await page.bringToFront();
  const delayed = await waitFor(async () => {
    const t = await overlayText(page);
    return t && /EN: こんにちは、世界。/.test(t) ? t : null;
  });
  check('+0.5 s delay brings the cue back', !!delayed);
  check('popup shows the delay value', (await popup.locator('#delayVal').textContent()) === '+0.5s');

  // Reload: the background hands the cues (and delay) back to the fresh content script.
  await page.reload();
  await page.waitForSelector('#v');
  await page.bringToFront();
  await seekTo(page, 6);
  const restored = await waitFor(async () => {
    const t = await overlayText(page);
    return t && /EN: これは字幕オーバーレイのテストです。/.test(t) ? t : null;
  });
  check('subtitles survive a page reload', !!restored, restored || (await overlayText(page)));

  // Fullscreen: only the fullscreen element's subtree is visible, so the overlay must move inside it and back.
  await page.bringToFront();
  await page.click('#fs');
  const fsId = await waitFor(
    () => page.evaluate(() => {
      const fs = document.fullscreenElement;
      const host = document.querySelector('[data-subtitle-overlay]');
      return fs && host && host.parentNode === fs ? fs.id : null;
    }),
    { timeout: 5000 },
  );
  check('overlay moves into the fullscreen element', fsId === 'player', `fullscreenElement: ${fsId}`);
  await page.evaluate(() => document.exitFullscreen().catch(() => {}));
  const back = await waitFor(
    () => page.evaluate(() => {
      const host = document.querySelector('[data-subtitle-overlay]');
      return !document.fullscreenElement && !!host && host.parentNode === document.documentElement;
    }),
    { timeout: 5000 },
  );
  check('overlay returns to the document after fullscreen', !!back);

  // A stock Ollama (no OLLAMA_ORIGINS) answers 403 to chrome-extension:// origins; the rule must get us through.
  const realOllama = await fetch('http://127.0.0.1:11434/api/version').then((r) => r.ok).catch(() => false);
  if (realOllama) {
    await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), { ...localSettings, ollamaUrl: 'http://127.0.0.1:11434' });
    const status = await waitFor(
      () => sw.evaluate(() => fetch('http://127.0.0.1:11434/api/tags').then((r) => (r.status === 200 ? 200 : null), () => null)),
      { timeout: 5000 },
    );
    check('the real Ollama accepts requests from the extension', status === 200, `status ${status}`);
    await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), localSettings);
  } else {
    console.log('skip the real-Ollama check (Ollama is not running on 127.0.0.1:11434)');
  }

  // Live-start error path: the offscreen document is created and getUserMedia fails on a bogus stream id.
  const live = await popup.evaluate((tid) => chrome.runtime.sendMessage({ target: 'background', type: 'live:start', tabId: tid, streamId: 'bogus-stream-id', url: location.href }), tabId);
  check('live:start with a bogus stream id fails cleanly', live && live.ok === false && typeof live.error === 'string', live && live.error);
  const liveStatus = await popup.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'live:status' }));
  check('live:status reports not running', liveStatus && liveStatus.running === false, JSON.stringify(liveStatus));

  // Clear removes the overlay.
  await popup.bringToFront();
  await popup.click('#clear');
  await page.bringToFront();
  const cleared = await waitFor(() => page.evaluate(() => !document.querySelector('[data-subtitle-overlay]')));
  check('clear removes the overlay', !!cleared);

  check('no uncaught errors in the page or the popup', pageErrors.length === 0, pageErrors.join('; '));
} catch (e) {
  check('e2e run completed', false, e.stack || String(e));
} finally {
  await context.close().catch(() => {});
  mock.server.close();
  site.server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
