// Measures live-subtitle delay with the real local models (macOS). Speaks a Japanese passage with the system
// voice "Kyoko", streams it through the same segmenter and pipeline the extension uses at real-time speed, and
// reports when text appears for each piece of speech. Compares the old and the current segmenting settings.
// Usage: node test/live-latency.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Segmenter, encodeWav } from '../lib/audio.js';
import { LivePipeline } from '../lib/live-pipeline.js';
import { DEFAULTS } from '../lib/settings.js';
import { sttTranscribe, translateTexts, isHallucination, warmUpLocal } from '../lib/providers.js';

const PASSAGE =
  'みんな、聞いて。明日の朝、駅前のカフェで集まろう。' +
  '九時に着いたら、まず全員で地図を確認して、それから山の方へ出発するつもりなんだけど、' +
  '雨が降ったら計画を変えるから、夜のうちにメッセージを送るね。じゃあ、また明日。';

const CONFIGS = [
  { label: 'before: 1.5 s / 7 s / 600 ms, no drafts', min: 1.5, max: 7, silence: 600, drafts: false },
  { label: 'now: 1 s / 3.5 s / 350 ms, drafts', min: DEFAULTS.minSegSec, max: DEFAULTS.maxSegSec, silence: DEFAULTS.silenceMs, drafts: true },
];

const settings = { ...DEFAULTS, engine: 'local' };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function readWav(file) {
  const buf = fs.readFileSync(file);
  let o = 12;
  while (o < buf.length - 8) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'data') {
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + o + 8, buf.byteOffset + o + 8 + size));
      return Float32Array.from(pcm, (v) => v / 32768);
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

async function run(cfg, samples) {
  const events = [];
  const pipeline = new LivePipeline({
    listen: (seg) => sttTranscribe(new Blob([encodeWav(seg.samples, 16000)], { type: 'audio/wav' }), settings, { language: 'ja' }),
    translate: async (text, context) => (await translateTexts([text], { settings, source: 'ja', target: 'en', context }))[0],
    isJunk: isHallucination,
    emit: (e) => events.push({ ...e, at: Date.now() }),
  });
  const segmenter = new Segmenter({
    sampleRate: 16000, minSegSec: cfg.min, maxSegSec: cfg.max, silenceMs: cfg.silence,
    progressEverySec: cfg.drafts ? 1 : 0,
    onSegment: (s) => pipeline.final(s),
    onProgress: (s) => pipeline.draft(s),
  });
  const audio = new Float32Array(samples.length + 16000 * 2); // two seconds of silence at the end
  audio.set(samples);
  const t0 = Date.now();
  for (let i = 0; i < audio.length; i += 1600) {
    const chunk = audio.subarray(i, i + 1600);
    await sleep(t0 + ((i + chunk.length) / 16000) * 1000 - Date.now()); // real time
    segmenter.push(chunk, Date.now());
  }
  while (pipeline.inflight || pipeline.queue.length || pipeline.draftBusy) await sleep(50);

  const bySeg = new Map();
  for (const e of events) {
    if (e.type !== 'cue' && e.type !== 'draft') continue;
    const r = bySeg.get(e.segId) || { segId: e.segId, wallStart: e.wallStart, wallEnd: e.wallEnd };
    if (e.text && r.firstAt == null) r.firstAt = e.at;
    if (e.type === 'cue') Object.assign(r, { finalAt: e.at, text: e.text, wallEnd: e.wallEnd });
    bySeg.set(e.segId, r);
  }
  const rows = [...bySeg.values()].filter((r) => r.text);
  const sec = (ms) => (ms / 1000).toFixed(1);
  console.log(`\n${cfg.label}`);
  console.table(
    rows.map((r) => ({
      speech: `${sec(r.wallStart - t0)}–${sec(r.wallEnd - t0)} s`,
      'first text after speech starts': `${sec(r.firstAt - r.wallStart)} s`,
      'final line after speech ends': `${sec(r.finalAt - r.wallEnd)} s`,
      english: r.text.length > 48 ? `${r.text.slice(0, 47)}…` : r.text,
    })),
  );
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return { first: avg(rows.map((r) => r.firstAt - r.wallStart)), worst: Math.max(...rows.map((r) => r.firstAt - r.wallStart)) };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-latency-'));
try {
  const file = path.join(dir, 'passage.wav');
  execFileSync('say', ['-v', 'Kyoko', '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', PASSAGE]);
  const samples = readWav(file);
  console.log(`passage: ${(samples.length / 16000).toFixed(1)} s of speech. Loading models…`);
  await warmUpLocal(settings);
  const summary = [];
  for (const cfg of CONFIGS) summary.push({ settings: cfg.label, ...(await run(cfg, samples)) });
  console.log('\nTime from the start of a piece of speech until any English shows:');
  console.table(summary.map((s) => ({ settings: s.settings, average: `${(s.first / 1000).toFixed(1)} s`, worst: `${(s.worst / 1000).toFixed(1)} s` })));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
