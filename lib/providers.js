// All network calls to the speech and translation engines.
// Used by the offscreen document (live audio) and the background worker (subtitle files, settings tests).
//
// Local engine (free, no keys):  MegaASR via the mlx-audio server  +  a Qwen model via Ollama.
// Cloud engine (API keys):       OpenAI Whisper  +  Claude or OpenAI.

import { DEFAULTS, isLocalUrl, isLocalEngine } from './settings.js';
import { encodeWav } from './audio.js';

const LANG_NAMES = {
  auto: 'the source language',
  ja: 'Japanese', en: 'English', ko: 'Korean', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German',
  it: 'Italian', pt: 'Portuguese', ru: 'Russian', id: 'Indonesian', th: 'Thai', vi: 'Vietnamese', tl: 'Filipino',
};
export const langName = (code) => LANG_NAMES[code] || code;

const joinUrl = (base, path) => String(base || '').replace(/\/+$/, '') + path;

async function errorText(res) {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t);
      return (typeof j.error === 'string' ? j.error : j.error?.message) || j.detail || j.message || t.slice(0, 300);
    } catch {
      return t.slice(0, 300);
    }
  } catch {
    return '';
  }
}

/** fetch() that turns "connection refused" into a readable message. */
async function fetchLocal(url, init, what, hint) {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`${what} is not reachable at ${new URL(url).origin}. ${hint}`);
  }
}

// ---------------------------------------------------------------- speech recognition

async function cloudStt(endpoint, blob, settings, { prompt, language } = {}) {
  const base = settings.openaiBaseUrl || DEFAULTS.openaiBaseUrl;
  if (!settings.openaiKey && !isLocalUrl(base)) throw new Error('OpenAI API key missing (add it in Settings)');
  const fd = new FormData();
  fd.append('file', blob, 'audio.wav');
  fd.append('model', settings.sttModel || 'whisper-1');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  if (prompt) fd.append('prompt', prompt);
  if (language) fd.append('language', language);
  const headers = {};
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  const res = await fetch(joinUrl(base, `/audio/${endpoint}`), { method: 'POST', headers, body: fd });
  if (!res.ok) throw new Error(`Speech API ${res.status}: ${await errorText(res)}`);
  const data = await res.json();
  return String(data.text || '').trim();
}

const SPEECH_HINT = 'Start it with: tools/setup-local.sh service';

/** MegaASR / Qwen3-ASR through mlx-audio. The model expects a language name ("Japanese"), not a code. */
async function localStt(blob, settings, { language } = {}) {
  const base = settings.localSpeechUrl || DEFAULTS.localSpeechUrl;
  const model = settings.localSpeechModel || DEFAULTS.localSpeechModel;
  const fd = new FormData();
  fd.append('file', blob, 'audio.wav');
  fd.append('model', model);
  fd.append('response_format', 'json');
  if (language && language !== 'auto') fd.append('language', langName(language));
  const res = await fetchLocal(joinUrl(base, '/audio/transcriptions'), { method: 'POST', body: fd }, 'The local speech server', SPEECH_HINT);
  if (!res.ok) {
    const detail = await errorText(res);
    if (res.status >= 500 || /offline|not found|does not exist|snapshot|incomplete|cannot find|LocalEntryNotFound/i.test(detail)) {
      // The server only says "Internal Server Error"; the usual cause is a model that is still downloading.
      throw new Error(`The speech model ${model} could not be loaded. If it is still downloading, check with: tools/setup-local.sh status`);
    }
    throw new Error(`Local speech server ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return String(data.text || '').trim();
}

/** Audio in any language → English text (Whisper's built-in translation; cloud engine only). */
export const sttTranslate = (blob, settings, opts) => cloudStt('translations', blob, settings, opts);

/** Audio → text in the spoken language. */
export function sttTranscribe(blob, settings, opts = {}) {
  if (isLocalEngine(settings)) return localStt(blob, settings, opts);
  return cloudStt('transcriptions', blob, settings, opts);
}

// ---------------------------------------------------------------- text translation

export function pickTranslator(s) {
  if (isLocalEngine(s)) return 'ollama';
  const openaiOk = !!s.openaiKey || isLocalUrl(s.openaiBaseUrl);
  if (s.textTranslator === 'claude') return s.anthropicKey ? 'claude' : 'none';
  if (s.textTranslator === 'openai') return openaiOk ? 'openai' : 'none';
  if (s.anthropicKey) return 'claude';
  if (openaiOk) return 'openai';
  return 'none';
}

/**
 * Translate an array of subtitle lines. Returns an array of the same length (empty string where the
 * model returned nothing). `context` = earlier lines [{ original, text }] for continuity only.
 */
export async function translateTexts(texts, { settings, source = 'ja', target = 'en', context = [] } = {}) {
  if (!texts.length) return [];
  const which = pickTranslator(settings);
  if (which === 'ollama') return ollamaTranslate(texts, { settings, source, target, context });
  if (which === 'claude') return claudeTranslate(texts, { settings, source, target, context });
  if (which === 'openai') return openaiTranslate(texts, { settings, source, target, context });
  throw new Error('No translation engine available (switch the engine to Local, or add an API key in Settings)');
}

const oneLine = (s) => String(s ?? '').replace(/\r?\n/g, '\\n');

export function buildPrompt(texts, source, target, context) {
  const src = source === 'auto' ? '' : `${langName(source)} `;
  const tgt = langName(target);
  const system = [
    `You translate ${src}subtitles into natural, fluent ${tgt} for on-screen display.`,
    'Guidelines:',
    '- Convey meaning, tone and register (casual, polite, rude, playful); do not translate word-for-word.',
    '- Keep each line short enough to read in about two seconds; keep any line breaks (\\n) that appear inside an entry.',
    '- Keep character names as names. Leave entries that are already in the target language, or that are only sound effects, unchanged.',
    '- Use the earlier lines only as context for pronouns, names and running jokes.',
    `- Translate every entry independently, in order. Never merge, split, drop or renumber entries: return exactly ${texts.length} strings.`,
    '- Respond with JSON only, in this shape: {"lines": ["...", "..."]}',
  ].join('\n');
  let user = '';
  if (context && context.length) {
    user +=
      'Earlier lines (context only — do not translate these):\n' +
      context.map((c) => `- ${oneLine(c.original)}${c.text ? ` => ${oneLine(c.text)}` : ''}`).join('\n') +
      '\n\n';
  }
  user += `Translate these ${texts.length} entries:\n` + texts.map((t, i) => `${i + 1}. ${oneLine(t)}`).join('\n');
  return { system, user };
}

/** Parse the model's reply into exactly `expected` strings (JSON object, JSON array or numbered lines). */
export function parseLines(raw, expected) {
  const text = String(raw ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // reasoning models that ignore think:false
    .trim();
  const tryJson = (s) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.lines)) return v.lines;
    } catch {
      /* not JSON */
    }
    return null;
  };
  let lines = tryJson(text);
  if (!lines) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a !== -1 && b > a) lines = tryJson(text.slice(a, b + 1));
  }
  if (!lines) {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a !== -1 && b > a) lines = tryJson(text.slice(a, b + 1));
  }
  if (!lines) {
    const numbered = [...text.matchAll(/^\s*\d+[.)]\s*(.*)$/gm)].map((m) => m[1]);
    if (numbered.length) lines = numbered;
  }
  if (!lines) throw new Error('Could not parse the translation response');
  lines = lines.map((l) => String(l ?? '').replace(/\\n/g, '\n').trim());
  while (lines.length < expected) lines.push('');
  return lines.slice(0, expected);
}

// ---- Ollama (local engine)

const OLLAMA_HINT = 'Open the Ollama app, then try again.';
const LINES_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'string' } } },
  required: ['lines'],
};

async function ollamaPost(settings, path, body) {
  const base = settings.ollamaUrl || DEFAULTS.ollamaUrl;
  return fetchLocal(
    joinUrl(base, path),
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    'Ollama',
    OLLAMA_HINT,
  );
}

async function ollamaError(res, settings) {
  const detail = await errorText(res);
  if (res.status === 404 || /not found/i.test(detail)) {
    return new Error(`The Ollama model ${settings.ollamaModel} is not downloaded yet. Run: ollama pull ${settings.ollamaModel}`);
  }
  if (res.status === 403) return new Error('Ollama refused the request (403). Reload the extension so it can fix the request origin.');
  return new Error(`Ollama ${res.status}: ${detail}`);
}

async function ollamaTranslate(texts, { settings, source, target, context }) {
  const { system, user } = buildPrompt(texts, source, target, context);
  const body = {
    model: settings.ollamaModel || DEFAULTS.ollamaModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: false,
    think: false, // Qwen3 reasons before answering by default; subtitles need the answer fast
    format: LINES_SCHEMA, // structured output: always {"lines": [...]}
    keep_alive: '30m',
    options: { temperature: 0.2 },
  };
  let res = await ollamaPost(settings, '/api/chat', body);
  if (res.status === 400) {
    const detail = await errorText(res);
    if (!/think/i.test(detail)) throw new Error(`Ollama 400: ${detail}`);
    delete body.think; // models without a thinking toggle reject the field
    res = await ollamaPost(settings, '/api/chat', body);
  }
  if (!res.ok) throw await ollamaError(res, settings);
  const data = await res.json();
  return parseLines(data.message?.content || '', texts.length);
}

// ---- Claude (cloud engine)

// Models that accept the server-side refusal fallback ("fallbacks": "default") and output_config.effort.
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/;
const NO_EFFORT_MODELS = /(haiku-4-5|sonnet-4-5|opus-4-1|claude-3)/;

async function claudeTranslate(texts, { settings, source, target, context }) {
  const { system, user } = buildPrompt(texts, source, target, context);
  const model = settings.claudeModel || DEFAULTS.claudeModel;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.anthropicKey,
    'anthropic-version': '2023-06-01',
    // Requests come from an extension page/worker, which the API treats as a browser client.
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (!NO_EFFORT_MODELS.test(model)) body.output_config = { effort: 'low' }; // subtitles need speed, not deep reasoning
  if (FALLBACK_MODELS.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default'; // if a safety classifier declines a batch, the API retries it on a fallback model
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await errorText(res)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    const cat = data.stop_details?.category;
    throw new Error(`Claude declined to translate this batch${cat ? ` (${cat})` : ''}`);
  }
  const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseLines(out, texts.length);
}

// ---- OpenAI (cloud engine)

async function openaiTranslate(texts, { settings, source, target, context }) {
  const { system, user } = buildPrompt(texts, source, target, context);
  const base = settings.openaiBaseUrl || DEFAULTS.openaiBaseUrl;
  const headers = { 'content-type': 'application/json' };
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  const body = {
    model: settings.openaiTextModel || DEFAULTS.openaiTextModel,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  };
  const res = await fetch(joinUrl(base, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await errorText(res)}`);
  const data = await res.json();
  return parseLines(data.choices?.[0]?.message?.content || '', texts.length);
}

// ---------------------------------------------------------------- warm-up and checks

const silentWav = () => new Blob([encodeWav(new Float32Array(8000), 16000)], { type: 'audio/wav' });

/** Load both local models ahead of the first real request (the first load takes a few seconds). */
export async function warmUpLocal(settings) {
  await Promise.allSettled([
    localStt(silentWav(), settings, { language: settings.sourceLang }),
    ollamaPost(settings, '/api/generate', { model: settings.ollamaModel || DEFAULTS.ollamaModel, keep_alive: '30m' }),
  ]);
}

export async function testLocalSpeech(settings) {
  const base = settings.localSpeechUrl || DEFAULTS.localSpeechUrl;
  const res = await fetchLocal(joinUrl(base, '/models'), {}, 'The local speech server', SPEECH_HINT);
  if (!res.ok) throw new Error(`Local speech server ${res.status}: ${await errorText(res)}`);
  const t0 = Date.now();
  await localStt(silentWav(), settings, { language: settings.sourceLang }); // loads the model
  const model = settings.localSpeechModel || DEFAULTS.localSpeechModel;
  return `Speech server and ${model} are ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
}

export async function testOllama(settings) {
  const base = settings.ollamaUrl || DEFAULTS.ollamaUrl;
  const res = await fetchLocal(joinUrl(base, '/api/tags'), {}, 'Ollama', OLLAMA_HINT);
  if (!res.ok) throw await ollamaError(res, settings);
  const { models = [] } = await res.json();
  const want = settings.ollamaModel || DEFAULTS.ollamaModel;
  const names = models.map((m) => m.name || m.model);
  if (!names.some((n) => n === want || n === `${want}:latest`)) {
    throw new Error(`Ollama is running, but ${want} is not downloaded yet. Run: ollama pull ${want}`);
  }
  const [out] = await ollamaTranslate(['こんにちは、元気ですか？'], { settings, source: 'ja', target: 'en', context: [] });
  return `Ollama works: こんにちは、元気ですか？ → ${out || '(empty)'}`;
}

export async function testOpenAI(settings) {
  const base = settings.openaiBaseUrl || DEFAULTS.openaiBaseUrl;
  const headers = {};
  if (settings.openaiKey) headers.Authorization = `Bearer ${settings.openaiKey}`;
  const res = await fetch(joinUrl(base, '/models'), { headers });
  if (!res.ok) throw new Error(`${res.status}: ${await errorText(res)}`);
  return 'OpenAI key works';
}

export async function testAnthropic(settings) {
  const out = await claudeTranslate(['こんにちは'], { settings, source: 'ja', target: 'en', context: [] });
  return `Claude works: こんにちは → ${out[0] || '(empty)'}`;
}

// ---------------------------------------------------------------- hallucination filter

const HALLUCINATIONS = [
  /^(thank you|thanks)( (so much|very much|all))?( for (watching|listening|your attention))?[.!]*$/i,
  /^(please )?(like,? )?(subscribe|share)( and (subscribe|like|comment))?[.!]*$/i,
  /^(don't forget to )?(like|subscribe)/i,
  /(subtitles?|subtitled|captions?|translat(ed|ion)) (by|from|provided by|created by)/i,
  /amara\.org/i,
  /^\[?\(?(music|applause|laughter|silence|inaudible|blank_audio|bgm)\)?\]?$/i,
  /^(you|bye|oh|hmm|uh|um)[.!]*$/i,
  /ご視聴ありがとうございました/,
  /チャンネル登録/,
  /字幕.*(提供|作成|制作)/,
  /^[\s.。、…・\-_~!?！？♪]*$/,
];

export function isHallucination(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  if (HALLUCINATIONS.some((r) => r.test(t))) return true;
  const words = t.split(/\s+/);
  if (words.length >= 8) {
    const uniq = new Set(words.map((w) => w.toLowerCase()));
    if (uniq.size <= Math.max(2, words.length / 5)) return true; // "ha ha ha ha ha ha" loops
  }
  if (t.length >= 12 && /^(.{1,6})\1{3,}$/.test(t)) return true; // repeated short phrase without spaces
  return false;
}
