import test from 'node:test';
import assert from 'node:assert/strict';
import { Resampler, encodeWav, Segmenter, concat } from '../lib/audio.js';

const SR = 16000;
const zeros = (n) => new Float32Array(n);
function noise(n, amp, seed = 1) {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return out;
}
/** Push `parts` through the segmenter in 100 ms chunks; sample i is heard at wall 1_000_000 + i/16 ms. */
function feed(seg, parts, chunk = 1600) {
  const all = parts.reduce((a, b) => concat(a, b), new Float32Array(0));
  let wall = 1_000_000;
  for (let i = 0; i < all.length; i += chunk) {
    const c = all.subarray(i, Math.min(all.length, i + chunk));
    wall += (c.length / SR) * 1000;
    seg.push(c, wall);
  }
}

test('Resampler 48k→16k keeps length, level and pitch across chunk boundaries', () => {
  const rs = new Resampler(48000, 16000);
  let total = 0;
  for (let i = 0; i < 100; i++) total += rs.process(new Float32Array(4096).fill(0.5)).length;
  assert.ok(Math.abs(total - 409600 / 3) < 2, `length ${total}`);
  assert.ok(rs.carry.length < 3);

  const rs2 = new Resampler(48000, 16000);
  const sine = new Float32Array(48000);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  const out = concat(rs2.process(sine.subarray(0, 20000)), rs2.process(sine.subarray(20000)));
  assert.equal(out.length, 16000);
  let crossings = 0;
  for (let i = 1; i < out.length; i++) if (out[i - 1] < 0 !== out[i] < 0) crossings++;
  assert.ok(Math.abs(crossings - 880) <= 2, `zero crossings ${crossings}`);
  assert.ok(Math.abs(out[4000]) <= 1);
});

test('encodeWav writes a valid 16-bit mono PCM header and clamps samples', () => {
  const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1.7, -1.7]), 16000);
  const v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(str(36, 4), 'data');
  assert.equal(v.getUint32(4, true), 36 + 10);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(28, true), 32000);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 10);
  assert.equal(buf.byteLength, 54);
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
  assert.equal(v.getInt16(50, true), 0x7fff);
  assert.equal(v.getInt16(52, true), -0x8000);
});

test('Segmenter cuts at pauses, keeps a pre-roll, drops silence and maps wall time', () => {
  const segments = [];
  const seg = new Segmenter({ sampleRate: SR, minSegSec: 1.5, maxSegSec: 7, silenceMs: 600, onSegment: (s) => segments.push(s) });
  feed(seg, [zeros(SR), noise(3 * SR, 0.3, 1), zeros(SR), noise(2 * SR, 0.3, 2), zeros(SR)]);
  assert.equal(segments.length, 2);
  const [a, b] = segments;
  assert.ok(a.duration > 3.3 && a.duration < 3.7, `first ${a.duration}`); // 0.24 s pre-roll + 3 s speech + 0.3 s tail
  assert.ok(b.duration > 2.3 && b.duration < 2.7, `second ${b.duration}`);
  assert.ok(Math.abs(a.wallEnd - a.wallStart - a.duration * 1000) < 1);
  assert.ok(Math.abs(a.wallStart - (1_000_000 + 1000 - 240)) <= 20, `wallStart ${a.wallStart}`);
  assert.ok(Math.abs(b.wallStart - (1_000_000 + 5000 - 240)) <= 20, `wallStart ${b.wallStart}`);
  assert.ok(a.speechRatio > 0.8 && a.speechRatio <= 1);
  assert.equal(a.samples.length, Math.round(a.duration * SR));
});

test('Segmenter force-cuts long speech at maxSegSec and flushes the rest', () => {
  const segments = [];
  const seg = new Segmenter({ sampleRate: SR, minSegSec: 1.5, maxSegSec: 7, silenceMs: 600, onSegment: (s) => segments.push(s) });
  feed(seg, [noise(20 * SR, 0.3, 3)]);
  assert.deepEqual(segments.map((s) => Math.round(s.duration * 10) / 10), [7, 7]);
  seg.flush();
  assert.equal(segments.length, 3);
  assert.ok(segments[2].duration > 5.5 && segments[2].duration <= 6.01, `flushed ${segments[2].duration}`);
  // contiguous: the next segment starts where the previous one ended
  assert.ok(Math.abs(segments[1].wallStart - segments[0].wallEnd) < 1);
});

test('Segmenter ignores silence and faint noise', () => {
  const segments = [];
  const seg = new Segmenter({ sampleRate: SR, onSegment: (s) => segments.push(s) });
  feed(seg, [zeros(10 * SR), noise(10 * SR, 0.004, 4)]);
  seg.flush();
  assert.equal(segments.length, 0);
});

test('Segmenter hands out draft snapshots of the open segment, sharing the final id', () => {
  const finals = [];
  const drafts = [];
  const seg = new Segmenter({
    sampleRate: SR, minSegSec: 1, maxSegSec: 3.5, silenceMs: 350, progressEverySec: 1,
    onSegment: (s) => finals.push(s), onProgress: (s) => drafts.push(s),
  });
  feed(seg, [zeros(SR), noise(2.8 * SR, 0.3, 5), zeros(SR), noise(1.5 * SR, 0.3, 6), zeros(SR)]);
  assert.equal(finals.length, 2);
  assert.deepEqual(finals.map((f) => f.id), [1, 2]);
  // segment 1 = 0.24 s lead-in + 2.8 s of speech: drafts at 1, 2 and 3 s; segment 2 (1.5 s of speech): one at 1 s
  assert.deepEqual(drafts.map((d) => d.id), [1, 1, 1, 2]);
  assert.ok(drafts.every((d) => d.draft === true));
  assert.ok(Math.abs(drafts[0].duration - 1) < 0.05, `first draft ${drafts[0].duration}`);
  assert.ok(Math.abs(drafts[1].duration - 2) < 0.05, `second draft ${drafts[1].duration}`);
  assert.equal(drafts[0].wallStart, finals[0].wallStart, 'a draft starts where its segment starts');
  assert.ok(drafts[1].wallEnd < finals[0].wallEnd);
});

test('Segmenter sends no drafts when they are turned off, and none during silence', () => {
  const drafts = [];
  const off = new Segmenter({ sampleRate: SR, onSegment: () => {}, onProgress: (s) => drafts.push(s) });
  feed(off, [noise(5 * SR, 0.3, 7)]);
  assert.equal(drafts.length, 0);
  const on = new Segmenter({ sampleRate: SR, progressEverySec: 1, onSegment: () => {}, onProgress: (s) => drafts.push(s) });
  feed(on, [zeros(5 * SR)]);
  assert.equal(drafts.length, 0);
});

test('Segmenter with the new defaults cuts continuous speech every 3.5 s', () => {
  const finals = [];
  const seg = new Segmenter({ sampleRate: SR, minSegSec: 1, maxSegSec: 3.5, silenceMs: 350, onSegment: (s) => finals.push(s) });
  feed(seg, [noise(8 * SR, 0.3, 8)]);
  assert.deepEqual(finals.map((f) => Math.round(f.duration * 10) / 10), [3.5, 3.5]);
});
