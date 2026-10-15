// Options page: API keys, models, languages and live-mode tuning.

import { getSettings, saveSettings } from './lib/settings.js';
import { testOpenAI, testAnthropic } from './lib/providers.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'openaiKey', 'sttModel', 'openaiBaseUrl',
  'anthropicKey', 'claudeModel', 'textTranslator', 'openaiTextModel',
  'liveMode', 'sourceLang', 'targetLang', 'minSegSec', 'maxSegSec', 'silenceMs',
];
const NUMERIC = new Set(['minSegSec', 'maxSegSec', 'silenceMs']);

function readForm() {
  const patch = {};
  for (const f of FIELDS) {
    const node = $(f);
    if (!node) continue;
    patch[f] = NUMERIC.has(f) ? Number(node.value) : node.value.trim();
  }
  if (!patch.openaiBaseUrl) patch.openaiBaseUrl = 'https://api.openai.com/v1';
  if (!patch.sttModel) patch.sttModel = 'whisper-1';
  if (!patch.claudeModel) patch.claudeModel = 'claude-opus-5-5';
  if (!patch.openaiTextModel) patch.openaiTextModel = 'gpt-4.1-mini';
  return patch;
}

async function runTest(buttonId, outId, fn) {
  const out = $(outId);
  const btn = $(buttonId);
  btn.disabled = true;
  out.className = 'info muted';
  out.textContent = 'Testing…';
  try {
    out.textContent = await fn({ ...(await getSettings()), ...readForm() });
    out.className = 'info ok';
  } catch (e) {
    out.textContent = e?.message || String(e);
    out.className = 'info error';
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  const s = await getSettings();
  for (const f of FIELDS) {
    const node = $(f);
    if (node) node.value = s[f] ?? '';
  }
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettings(readForm());
    $('saved').textContent = 'Saved';
    setTimeout(() => {
      $('saved').textContent = '';
    }, 2500);
  });
  $('testOpenai').addEventListener('click', () => runTest('testOpenai', 'openaiTest', testOpenAI));
  $('testAnthropic').addEventListener('click', () => runTest('testAnthropic', 'anthropicTest', testAnthropic));
}

init();
