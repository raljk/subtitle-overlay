// Extension settings with defaults, stored in chrome.storage.local.
// The default engine is 'local': free open-source models running on this Mac, no API keys.

export const DEFAULTS = Object.freeze({
  // 'local' = MegaASR speech recognition (mlx-audio server) + a Qwen model in Ollama, all on this Mac.
  // 'cloud' = OpenAI Whisper and Claude / OpenAI with your own API keys.
  engine: 'local',

  // Local engine (see tools/setup-local.sh)
  localSpeechUrl: 'http://127.0.0.1:8742/v1',
  localSpeechModel: 'mlx-community/Mega-ASR-bf16',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:8b',

  // Cloud engine: speech recognition (OpenAI Whisper, or any OpenAI-compatible server)
  openaiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',

  // Cloud engine: text translation
  anthropicKey: '',
  claudeModel: 'claude-opus-5-5',
  openaiTextModel: 'gpt-4.1-mini',
  textTranslator: 'auto', // auto | claude | openai

  // Cloud live pipeline: 'whisper-translate' = one Whisper call that returns English directly
  //                      'transcribe-translate' = transcribe the original, then translate it (bilingual)
  // The local engine always transcribes and then translates.
  liveMode: 'whisper-translate',
  sourceLang: 'ja',
  targetLang: 'en',
  autoTranslateFiles: true,

  // Live segmenting (seconds / milliseconds). Shorter segments mean less delay; the models keep up easily.
  minSegSec: 1,
  maxSegSec: 3.5,
  silenceMs: 350,
  // Show a grey draft of the line every ~second while someone is still talking, replaced by the final line.
  draftLines: true,
  draftEverySec: 1,

  // Display
  fontScale: 4.5, // % of the video height
  bottomPct: 6, // distance from the bottom edge, % of the video height
  boxOpacity: 0.6,
  showOriginal: false,
});

export const DISPLAY_KEYS = ['fontScale', 'bottomPct', 'boxOpacity', 'showOriginal'];

// Version 2 changed the live segmenting defaults. Stored values that still equal the old defaults were never
// chosen by the user (older versions saved every default), so they are dropped and the new defaults apply.
export const SETTINGS_VERSION = 2;
const V1_SEGMENTING = { minSegSec: 1.5, maxSegSec: 7, silenceMs: 600 };

export function migrateSettings(stored) {
  const s = { ...(stored || {}) };
  if ((s.settingsVersion || 1) < 2) {
    for (const [k, v] of Object.entries(V1_SEGMENTING)) if (Number(s[k]) === v) delete s[k];
  }
  s.settingsVersion = SETTINGS_VERSION;
  return s;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const migrated = migrateSettings(settings);
  if (settings && settings.settingsVersion !== SETTINGS_VERSION) await chrome.storage.local.set({ settings: migrated });
  return { ...DEFAULTS, ...migrated };
}

/** Stores only what the user set (plus the patch), so future default changes still reach them. */
export async function saveSettings(patch) {
  const { settings } = await chrome.storage.local.get('settings');
  const next = { ...migrateSettings(settings), ...patch };
  await chrome.storage.local.set({ settings: next });
  return { ...DEFAULTS, ...next };
}

export function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url || '');
}

export const isLocalEngine = (s) => (s?.engine || DEFAULTS.engine) === 'local';

/** True when the live pipeline transcribes first and translates second (always for the local engine). */
export const usesTranscribeThenTranslate = (s) => isLocalEngine(s) || s?.liveMode === 'transcribe-translate';

/** Why live subtitles cannot start with these settings, or '' when they can. */
export function liveBlocker(s) {
  if (isLocalEngine(s)) return '';
  const speechOk = !!s.openaiKey || isLocalUrl(s.openaiBaseUrl);
  if (!speechOk) return 'Add your OpenAI API key in Settings, or switch the engine to Local.';
  if (s.liveMode === 'transcribe-translate' && !s.anthropicKey && !speechOk) return 'Bilingual mode needs an Anthropic or OpenAI key.';
  return '';
}

/** Why subtitle files cannot be translated with these settings, or '' when they can. */
export function translateBlocker(s) {
  if (isLocalEngine(s)) return '';
  if (s.anthropicKey || s.openaiKey || isLocalUrl(s.openaiBaseUrl)) return '';
  return 'Add an Anthropic or OpenAI API key in Settings, or switch the engine to Local.';
}

/** Short description of the active engine for the popup. */
export function engineLabel(s) {
  if (isLocalEngine(s)) return `Local: ${shortModel(s.localSpeechModel)} + ${s.ollamaModel}`;
  return s.liveMode === 'transcribe-translate' ? 'Cloud: transcribe + translate' : 'Cloud: Whisper translate';
}

function shortModel(id) {
  const name = String(id || '').split('/').pop();
  return name.replace(/-(bf16|fp16|8bit|4bit|mlx.*)$/i, '');
}
