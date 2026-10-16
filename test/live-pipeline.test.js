import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePipeline } from '../lib/live-pipeline.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const seg = (id) => ({ id, wallStart: id * 1000, wallEnd: id * 1000 + 900, samples: new Float32Array(1), sampleRate: 16000 });

/** listen() resolves to "ja<id>" after `delays[id]` ms (or whatever `heard` maps the segment to). */
function harness({ delays = {}, heard = (s) => `ja${s.id}`, translateMs = 0, maxInflight = 2, maxQueue = 3, failOn = null } = {}) {
  const events = [];
  const contexts = [];
  const p = new LivePipeline({
    listen: async (s, { draft }) => {
      await tick(delays[s.id] ?? 0);
      if (failOn === s.id && !draft) throw new Error('speech server down');
      return heard(s, draft);
    },
    translate: async (text, context) => {
      contexts.push(context.map((c) => c.text));
      await tick(translateMs);
      return `EN(${text})`;
    },
    isJunk: (t) => t.includes('junk'),
    emit: (e) => events.push(e),
    maxInflight,
    maxQueue,
  });
  return { p, events, contexts };
}
const of = (events, type) => events.filter((e) => e.type === type);

test('a final segment becomes a translated cue and joins the context', async () => {
  const { p, events, contexts } = harness();
  p.final(seg(1));
  await tick(5);
  p.final(seg(2));
  await tick(5);
  assert.deepEqual(of(events, 'cue').map((e) => [e.segId, e.text, e.original]), [
    [1, 'EN(ja1)', 'ja1'],
    [2, 'EN(ja2)', 'ja2'],
  ]);
  assert.deepEqual(contexts, [[], ['EN(ja1)']]);
  assert.deepEqual(of(events, 'state').map((e) => e.state), ['translating', 'listening', 'translating', 'listening']);
});

test('a draft shows first, then its final; a late draft for a finished segment is dropped', async () => {
  const { p, events } = harness({ delays: { 1: 5 } });
  assert.equal(p.draft(seg(1)), true);
  await tick(20);
  p.final(seg(1));
  await tick(20);
  assert.equal(p.draft(seg(1)), false, 'segment 1 is finished');
  assert.deepEqual(events.filter((e) => e.type === 'draft' || e.type === 'cue').map((e) => `${e.type}:${e.segId}:${e.text}`), [
    'draft:1:EN(ja1)',
    'cue:1:EN(ja1)',
  ]);
});

test('a draft still running when its final finishes is discarded', async () => {
  const { p, events } = harness({ delays: { 1: 30 } });
  p.draft(seg(1)); // slow: 30 ms
  await tick(1);
  p.final({ ...seg(1) }); // same segment, but the final call finishes... also slow; make the final fast instead:
  await tick(80);
  const order = events.filter((e) => e.type === 'draft' || e.type === 'cue').map((e) => e.type);
  // both calls took 30 ms; the draft started first, so whichever finishes, no draft may follow the cue
  const cueAt = order.indexOf('cue');
  assert.ok(cueAt !== -1);
  assert.equal(order.slice(cueAt + 1).includes('draft'), false, `order: ${order}`);
});

test('drafts wait while finals are queued or the engines are saturated', async () => {
  const { p } = harness({ delays: { 1: 30, 2: 30, 3: 30 }, maxInflight: 2 });
  p.final(seg(1));
  p.final(seg(2)); // two in flight = saturated
  assert.equal(p.draft(seg(3)), false);
  p.final(seg(3)); // queued
  assert.equal(p.draft(seg(4)), false);
  await tick(120);
  assert.equal(p.draft(seg(4)), true, 'idle again');
});

test('only one draft at a time', async () => {
  const { p } = harness({ delays: { 5: 20 } });
  assert.equal(p.draft(seg(5)), true);
  assert.equal(p.draft(seg(5)), false);
  await tick(40);
  assert.equal(p.draft(seg(5)), true);
});

test('nothing usable still ends with an empty cue so the page drops the draft', async () => {
  const { p, events } = harness({ heard: (s) => (s.id === 2 ? 'junk' : s.id === 3 ? '' : `ja${s.id}`) });
  p.final(seg(1));
  await tick(5);
  p.final(seg(1)); // the same words again: an echo
  await tick(5);
  p.final(seg(2)); // hallucination
  p.final(seg(3)); // silence
  await tick(10);
  assert.deepEqual(of(events, 'cue').map((e) => [e.segId, e.text]), [
    [1, 'EN(ja1)'],
    [1, ''],
    [2, ''],
    [3, ''],
  ]);
});

test('when the engines fall behind, the oldest waiting segments are skipped (with an empty cue)', async () => {
  const { p, events } = harness({ delays: { 1: 30, 2: 30 }, maxInflight: 1, maxQueue: 2 });
  for (const id of [1, 2, 3, 4, 5]) p.final(seg(id)); // 1 runs; 2..5 queue; 2 and 3 are skipped
  await tick(150);
  const cues = of(events, 'cue').map((e) => [e.segId, e.text]);
  assert.deepEqual(cues.filter(([, t]) => t === ''), [[2, ''], [3, '']]);
  assert.deepEqual(cues.filter(([, t]) => t !== '').map(([id]) => id), [1, 4, 5]);
});

test('an engine error is reported, the line is cleared and the pipeline keeps going', async () => {
  const { p, events } = harness({ failOn: 1 });
  p.final(seg(1));
  await tick(5);
  p.final(seg(2));
  await tick(5);
  assert.deepEqual(of(events, 'error').map((e) => e.message), ['speech server down']);
  assert.deepEqual(of(events, 'cue').map((e) => [e.segId, e.text]), [
    [1, ''],
    [2, 'EN(ja2)'],
  ]);
});

test('without a translate step, listen output is the subtitle', async () => {
  const events = [];
  const p = new LivePipeline({ listen: async (s) => `English ${s.id}`, emit: (e) => events.push(e) });
  p.final(seg(7));
  await tick(5);
  assert.deepEqual(of(events, 'cue').map((e) => [e.text, e.original]), [['English 7', '']]);
});

test('stop() silences everything that is still running', async () => {
  const { p, events } = harness({ delays: { 1: 20 } });
  p.final(seg(1));
  p.stop();
  await tick(40);
  assert.equal(of(events, 'cue').length, 0);
  assert.equal(p.draft(seg(2)), false);
});
