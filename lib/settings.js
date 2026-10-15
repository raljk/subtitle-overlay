// Extension settings with defaults. Stored in chrome.storage.local (API keys never leave the browser
// except in requests to the providers you configure).

export const DEFAULTS = Object.freeze({
  // Speech recognition (OpenAI Whisper, or any OpenAI-compatible server such as a local whisper server)
  openaiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  sttModel: 'whisper-1',

  // Text translation (subtitle files, and the bilingual live mode)
  anthropicKey: '',
  claudeModel: 'claude-opus-5-5',
  openaiTextModel: 'gpt-4.1-mini',
  textTranslator: 'auto', // auto | claude | openai

  // Live mode: 'whisper-translate' = one Whisper call that returns English directly (fastest)
  //            'transcribe-translate' = Whisper transcribes the original, Claude/OpenAI translates (bilingual)
  liveMode: 'whisper-translate',
  sourceLang: 'ja',
  targetLang: 'en',
  autoTranslateFiles: true,

  // Live segmenting (seconds / milliseconds)
  minSegSec: 1.5,
  maxSegSec: 7,
  silenceMs: 600,

  // Display
  fontScale: 4.5, // % of the video height
  bottomPct: 6, // distance from the bottom edge, % of the video height
  boxOpacity: 0.6,
  showOriginal: false,
});

export const DISPLAY_KEYS = ['fontScale', 'bottomPct', 'boxOpacity', 'showOriginal'];

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url || '');
}
