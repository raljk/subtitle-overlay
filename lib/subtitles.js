// Subtitle parsing (SRT, WebVTT, ASS/SSA) and small text helpers.
// Pure functions: no DOM, no chrome.* — shared by the popup, the background worker and the tests.

const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

/** "01:02:03,456", "02:03.456" or ASS "0:02:03.45" → seconds. Returns null when no time is found. */
export function parseTime(str) {
  const m = TIME_RE.exec(String(str ?? ''));
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const s = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0').slice(0, 3), 10); // SRT uses ms, ASS uses centiseconds
  return h * 3600 + min * 60 + s + ms / 1000;
}

/** Seconds → "h:mm:ss" (or "m:ss"). */
export function formatTime(sec) {
  const t = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
}

const stripBom = (t) => t.replace(/^﻿/, '');

/** Decode subtitle bytes: UTF-16 BOMs, strict UTF-8, then the Japanese legacy encodings (Shift_JIS, EUC-JP). */
export function decodeSubtitleBytes(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return stripBom(new TextDecoder('utf-16le').decode(bytes));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return stripBom(new TextDecoder('utf-16be').decode(bytes));
  try {
    return stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    /* not valid UTF-8: try legacy encodings */
  }
  for (const enc of ['shift_jis', 'euc-jp']) {
    try {
      return stripBom(new TextDecoder(enc, { fatal: true }).decode(bytes));
    } catch {
      /* try the next one */
    }
  }
  return stripBom(new TextDecoder('utf-8').decode(bytes));
}

export function detectFormat(text, filename = '') {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const head = text.slice(0, 4000);
  if (/^\s*WEBVTT/.test(head)) return 'vtt';
  if (ext === 'ass' || ext === 'ssa' || /^\s*\[Script Info\]/im.test(head) || /^\s*\[Events\]/m.test(text)) return 'ass';
  if (ext === 'vtt') return 'vtt';
  return 'srt';
}

/** Parse any supported subtitle text. Returns { format, cues: [{ start, end, text }] } sorted by start. */
export function parseSubtitles(text, filename = '') {
  const format = detectFormat(text, filename);
  const cues = format === 'vtt' ? parseVtt(text) : format === 'ass' ? parseAss(text) : parseSrt(text);
  return { format, cues: normalizeCues(cues) };
}

/** Strip markup (HTML-ish tags, ASS override tags, WebVTT timestamps, entities) and tidy whitespace. */
export function cleanText(raw) {
  return String(raw ?? '')
    .replace(/\r/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>/g, '') // WebVTT inline timestamps <00:00:01.000>
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // <i>, </b>, <font ...>, <c.yellow>, <v Speaker>
    .replace(/\{\\[^}]*\}/g, '') // ASS override tags {\an8}, {\pos(..)}, {\i1}
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

function parseBlocks(text, skipBlock) {
  const src = stripBom(text).replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of src.split(/\n[ \t]*\n+/)) {
    if (skipBlock && skipBlock(block)) continue;
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti === -1) continue;
    const [a, b] = lines[ti].split('-->');
    const start = parseTime(a);
    const end = parseTime(b);
    if (start == null || end == null) continue;
    const body = cleanText(lines.slice(ti + 1).join('\n'));
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

export function parseSrt(text) {
  return parseBlocks(text, null);
}

export function parseVtt(text) {
  return parseBlocks(text, (b) => /^\s*(WEBVTT|NOTE|STYLE|REGION)\b/.test(b));
}

/** Advanced SubStation Alpha (.ass / .ssa): [Events] Dialogue lines. */
export function parseAss(text) {
  const cues = [];
  let inEvents = false;
  let format = null;
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inEvents = /^\[events\]/i.test(line);
      format = null;
      continue;
    }
    if (!inEvents) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    if (key === 'format') {
      format = value.split(',').map((f) => f.trim().toLowerCase());
      continue;
    }
    if (key !== 'dialogue') continue;
    const fields = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const parts = splitN(value, ',', fields.length); // the text field is last and may contain commas
    const rec = {};
    fields.forEach((f, i) => {
      rec[f] = (parts[i] ?? '').trim();
    });
    const start = parseTime(rec.start);
    const end = parseTime(rec.end);
    if (start == null || end == null) continue;
    const body = cleanText((rec.text || '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' '));
    if (body) cues.push({ start, end, text: body });
  }
  return cues;
}

function splitN(s, sep, n) {
  const out = [];
  let rest = s;
  while (out.length < n - 1) {
    const i = rest.indexOf(sep);
    if (i === -1) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  out.push(rest);
  return out;
}

const round3 = (n) => Math.round(n * 1000) / 1000;

function normalizeCues(cues) {
  const out = cues
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.text && c.text.trim())
    .map((c) => ({ start: round3(c.start), end: round3(c.end), text: c.text.trim() }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const dedup = [];
  for (const c of out) {
    const p = dedup[dedup.length - 1];
    if (p && p.start === c.start && p.end === c.end && p.text === c.text) continue; // layered duplicates (ASS)
    dedup.push(c);
  }
  return dedup;
}

/** Share of letters that are kana / kanji / half-width katakana. */
export function japaneseRatio(text) {
  let ja = 0;
  let letters = 0;
  for (const ch of String(text ?? '')) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xff66 && c <= 0xff9d)) {
      ja++;
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
    }
  }
  return letters ? ja / letters : 0;
}

export function looksJapanese(text) {
  return japaneseRatio(text) > 0.3;
}

/** FNV-1a 32-bit hash as hex; used to cache translations per file. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
