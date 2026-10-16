// Offscreen document: captures the tab's audio, cuts it into speech segments, sends each segment to
// the speech API (and optionally a translation model) and reports the resulting cues to the
// background worker, which forwards them to the page.

import { Segmenter, Resampler, encodeWav } from './lib/audio.js';
import { sttTranslate, sttTranscribe, translateTexts, isHallucination, warmUpLocal } from './lib/providers.js';
import { DEFAULTS, isLocalEngine, liveBlocker, usesTranscribeThenTranslate } from './lib/settings.js';

const MAX_INFLIGHT = 2; // concurrent API calls
const MAX_QUEUE = 3; // segments waiting; older ones are dropped if the API falls behind

let session = null;
let cueSeq = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
      );
      return true;
    case 'stop':
      stop('stopped');
      sendResponse({ ok: true });
      return;
    case 'status':
      sendResponse(status());
      return;
    default:
      return;
  }
});

function status() {
  if (!session) return { running: false };
  return {
    running: true,
    tabId: session.tabId,
    state: session.state,
    error: session.lastError,
    inflight: session.inflight,
    queued: session.queue.length,
    segments: session.segments,
    startedAt: session.startedAt,
    mode: usesTranscribeThenTranslate(session.settings) ? 'transcribe-translate' : 'whisper-translate',
  };
}

async function start({ streamId, tabId, settings: given }) {
  stop('restart');
  const settings = { ...DEFAULTS, ...(given || {}) }; // sent by the background (no chrome.storage here)
  const blocker = liveBlocker(settings);
  if (blocker) throw new Error(blocker);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  if (isLocalEngine(settings)) warmUpLocal(settings).catch(() => {}); // load both models before the first line
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const source = ctx.createMediaStreamSource(stream);
  const capture = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const resampler = new Resampler(ctx.sampleRate, 16000);
  const segmenter = new Segmenter({
    sampleRate: 16000,
    minSegSec: Number(settings.minSegSec) || 1.5,
    maxSegSec: Number(settings.maxSegSec) || 7,
    silenceMs: Number(settings.silenceMs) || 600,
    onSegment: enqueue,
  });

  session = {
    tabId, settings, stream, ctx, segmenter,
    state: 'listening', lastError: null, inflight: 0, queue: [], segments: 0,
    startedAt: Date.now(), history: [], lastText: '', lastOriginal: '',
  };
  const mine = session;
  capture.port.onmessage = (e) => {
    if (session !== mine) return;
    segmenter.push(resampler.process(e.data), Date.now());
  };
  source.connect(capture);
  capture.connect(ctx.destination); // the worklet outputs silence; connecting it keeps the graph running
  source.connect(ctx.destination); // play the captured audio back, otherwise the tab goes silent while captured
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  if (ctx.state !== 'running') {
    // While captured, the tab is only audible through this context: never leave it muted with nothing happening.
    session = null;
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw new Error(`Audio capture could not start (AudioContext is ${ctx.state}). Try again from the popup.`);
  }
  for (const track of stream.getAudioTracks()) {
    track.onended = () => {
      if (session === mine) stop('ended');
    };
  }
  report('listening');
}

function stop(reason) {
  const s = session;
  if (!s) return;
  session = null;
  try {
    s.stream.getTracks().forEach((t) => t.stop());
  } catch {
    /* ignore */
  }
  try {
    s.ctx.close();
  } catch {
    /* ignore */
  }
  if (reason === 'stopped' || reason === 'ended') report(reason, undefined, s.tabId);
}

function report(state, detail, tabId = session?.tabId) {
  if (session && state !== 'stopped' && state !== 'ended') session.state = state;
  chrome.runtime.sendMessage({ target: 'background', type: 'live:state', tabId, state, detail }).catch(() => {});
}

function enqueue(seg) {
  if (!session) return;
  session.segments++;
  session.queue.push(seg);
  while (session.queue.length > MAX_QUEUE) session.queue.shift(); // fell behind: skip the oldest audio
  pump();
}

function pump() {
  while (session && session.inflight < MAX_INFLIGHT && session.queue.length) {
    const s = session;
    const seg = s.queue.shift();
    s.inflight++;
    processSegment(s, seg)
      .catch(() => {})
      .finally(() => {
        s.inflight--;
        if (session !== s) return;
        if (s.inflight === 0 && !s.queue.length && s.state !== 'error') report('listening');
        pump();
      });
  }
}

async function processSegment(s, seg) {
  report('translating');
  const blob = new Blob([encodeWav(seg.samples, seg.sampleRate)], { type: 'audio/wav' });
  try {
    let text;
    let original = '';
    if (usesTranscribeThenTranslate(s.settings)) {
      const language = s.settings.sourceLang && s.settings.sourceLang !== 'auto' ? s.settings.sourceLang : undefined;
      original = await sttTranscribe(blob, s.settings, { prompt: promptFrom(s.history, 'original'), language });
      if (!original || isHallucination(original) || original === s.lastOriginal) return;
      [text] = await translateTexts([original], {
        settings: s.settings,
        source: s.settings.sourceLang || 'auto',
        target: s.settings.targetLang || 'en',
        context: s.history.slice(-4),
      });
    } else {
      text = await sttTranslate(blob, s.settings, { prompt: promptFrom(s.history, 'text') });
    }
    text = String(text || '').trim();
    if (!text || isHallucination(text) || text === s.lastText) return;
    s.lastText = text;
    s.lastOriginal = original;
    s.history.push({ original, text });
    if (s.history.length > 8) s.history.shift();
    s.lastError = null;
    if (session !== s) return;
    chrome.runtime
      .sendMessage({
        target: 'background',
        type: 'live:cue',
        tabId: s.tabId,
        cue: { id: `live-${++cueSeq}`, text, original, wallStart: seg.wallStart, wallEnd: seg.wallEnd },
      })
      .catch(() => {});
  } catch (e) {
    s.lastError = e?.message || String(e);
    if (session === s) report('error', s.lastError);
  }
}

/** Recent output as a Whisper "prompt": keeps names and spelling consistent between segments. */
function promptFrom(history, key) {
  const parts = history.slice(-3).map((h) => h[key]).filter(Boolean);
  let p = parts.join(' ');
  if (p.length > 220) p = p.slice(-220);
  return p;
}
