// Options page: engine choice, local servers, API keys, models, languages and live-mode tuning.

import { getSettings, saveSettings } from './lib/settings.js';
import { testOpenAI, testAnthropic } from './lib/providers.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'engine', 'localSpeechUrl', 'localSpeechModel', 'ollamaUrl', 'ollamaModel',
  'openaiKey', 'sttModel', 'openaiBaseUrl',
  'anthropicKey', 'claudeModel', 'textTranslator', 'openaiTextModel',
  'liveMode', 'sourceLang', 'targetLang', 'draftLines', 'minSegSec', 'maxSegSec', 'silenceMs',
];
const NUMERIC = new Set(['minSegSec', 'maxSegSec', 'silenceMs']);
const BOOLEAN = new Set(['draftLines']);
const FALLBACKS = {
  localSpeechUrl: 'http://127.0.0.1:8742/v1',
  localSpeechModel: 'mlx-community/Mega-ASR-bf16',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',
  claudeModel: 'claude-opus-5-5',
  openaiTextModel: 'gpt-4.1-mini',
};

function readForm() {
  const patch = {};
  for (const f of FIELDS) {
    const node = $(f);
    if (!node) continue;
    patch[f] = BOOLEAN.has(f) ? node.checked : NUMERIC.has(f) ? Number(node.value) : node.value.trim();
  }
  for (const [k, v] of Object.entries(FALLBACKS)) if (!patch[k]) patch[k] = v;
  return patch;
}

function showEngine() {
  const engine = $('engine').value;
  for (const node of document.querySelectorAll('[data-engine]')) node.hidden = node.dataset.engine !== engine;
}

function setResult(out, text, cls) {
  out.textContent = text;
  out.className = `info ${cls}`;
}

/** Runs a check with the values currently in the form. */
async function runTest(buttonId, outId, fn) {
  const out = $(outId);
  const btn = $(buttonId);
  btn.disabled = true;
  setResult(out, 'Testing… the first test loads the model and can take a minute.', 'muted');
  try {
    setResult(out, await fn(), 'ok');
  } catch (e) {
    setResult(out, e?.message || String(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Local checks run in the background worker, the same request path the subtitles use. */
async function localTest(what) {
  await saveSettings(readForm());
  const r = await chrome.runtime.sendMessage({ target: 'background', type: 'local:test', what });
  if (!r || !r.ok) throw new Error((r && r.error) || 'No answer from the extension');
  return r.message;
}

async function init() {
  const s = await getSettings();
  for (const f of FIELDS) {
    const node = $(f);
    if (!node) continue;
    if (BOOLEAN.has(f)) node.checked = !!s[f];
    else node.value = s[f] ?? '';
  }
  showEngine();
  $('engine').addEventListener('change', showEngine);
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettings(readForm());
    $('saved').textContent = 'Saved';
    setTimeout(() => {
      $('saved').textContent = '';
    }, 2500);
  });
  $('testSpeech').addEventListener('click', () => runTest('testSpeech', 'speechTest', () => localTest('speech')));
  $('testOllama').addEventListener('click', () => runTest('testOllama', 'ollamaTest', () => localTest('ollama')));
  $('testOpenai').addEventListener('click', () =>
    runTest('testOpenai', 'openaiTest', async () => testOpenAI({ ...(await getSettings()), ...readForm() })),
  );
  $('testAnthropic').addEventListener('click', () =>
    runTest('testAnthropic', 'anthropicTest', async () => testAnthropic({ ...(await getSettings()), ...readForm() })),
  );
}

init();
