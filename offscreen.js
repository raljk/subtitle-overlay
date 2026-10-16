// Offscreen document: captures the tab's audio, cuts it into speech segments and runs them through the
// live pipeline (speech recognition, then translation), reporting draft and final lines to the background
// worker, which forwards them to the page.

import { Segmenter, Resampler, encodeWav } from './lib/audio.js';
import { LivePipeline } from './lib/live-pipeline.js';
import { sttTranslate, sttTranscribe, translateTexts, isHallucination, warmUpLocal } from './lib/providers.js';
import { DEFAULTS, isLocalEngine, liveBlocker, usesTranscribeThenTranslate } from './lib/settings.js';

let session = null;

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
  const p = session.pipeline;
  return {
    running: true,
    tabId: session.tabId,
    state: session.state,
    error: session.lastError,
    inflight: p.inflight,
    queued: p.queue.length,
    segments: p.segments,
    drafts: p.drafts,
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

  const s = { tabId, settings, stream, ctx, state: 'listening', lastError: null, startedAt: Date.now() };
  s.pipeline = makePipeline(s);
  s.segmenter = new Segmenter({
    sampleRate: 16000,
    minSegSec: Number(settings.minSegSec) || DEFAULTS.minSegSec,
    maxSegSec: Number(settings.maxSegSec) || DEFAULTS.maxSegSec,
    silenceMs: Number(settings.silenceMs) || DEFAULTS.silenceMs,
    progressEverySec: settings.draftLines ? Number(settings.draftEverySec) || DEFAULTS.draftEverySec : 0,
    onSegment: (seg) => s.pipeline.final(seg),
    onProgress: (seg) => s.pipeline.draft(seg),
  });
  session = s;

  capture.port.onmessage = (e) => {
    if (session !== s) return;
    s.segmenter.push(resampler.process(e.data), Date.now());
  };
  source.connect(capture);
  capture.connect(ctx.destination); // the worklet outputs silence; connecting it keeps the graph running
  source.connect(ctx.destination); // play the captured audio back, otherwise the tab goes silent while captured
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  if (ctx.state !== 'running') {
    // While captured, the tab is only audible through this context: never leave it muted with nothing happening.
    session = null;
    s.pipeline.stop();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    throw new Error(`Audio capture could not start (AudioContext is ${ctx.state}). Try again from the popup.`);
  }
  for (const track of stream.getAudioTracks()) {
    track.onended = () => {
      if (session === s) stop('ended');
    };
  }
  report('listening');
}

/** Wires the pipeline to the configured engine and to the page. */
function makePipeline(s) {
  const { settings } = s;
  const twoStep = usesTranscribeThenTranslate(settings);
  const language = settings.sourceLang && settings.sourceLang !== 'auto' ? settings.sourceLang : undefined;
  const wav = (seg) => new Blob([encodeWav(seg.samples, seg.sampleRate)], { type: 'audio/wav' });
  const send = (msg) => chrome.runtime.sendMessage({ target: 'background', tabId: s.tabId, ...msg }).catch(() => {});

  return new LivePipeline({
    listen: (seg, { history }) =>
      twoStep
        ? sttTranscribe(wav(seg), settings, { prompt: promptFrom(history, 'original'), language })
        : sttTranslate(wav(seg), settings, { prompt: promptFrom(history, 'text') }),
    translate: twoStep
      ? async (text, context) => {
          const [out] = await translateTexts([text], {
            settings,
            source: settings.sourceLang || 'auto',
            target: settings.targetLang || 'en',
            context,
          });
          return out;
        }
      : null,
    isJunk: isHallucination,
    emit: (ev) => {
      if (session !== s) return;
      const line = { segId: ev.segId, text: ev.text, original: ev.original, wallStart: ev.wallStart, wallEnd: ev.wallEnd };
      if (ev.type === 'cue') {
        if (ev.text) s.lastError = null;
        send({ type: 'live:cue', cue: { id: `live-${ev.segId}`, ...line } });
      } else if (ev.type === 'draft') {
        send({ type: 'live:draft', draft: line });
      } else if (ev.type === 'state') {
        if (s.state !== 'error' || ev.state === 'translating') report(ev.state);
      } else if (ev.type === 'error') {
        s.lastError = ev.message;
        report('error', ev.message);
      }
    },
  });
}

function stop(reason) {
  const s = session;
  if (!s) return;
  session = null;
  s.pipeline.stop();
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

/** Recent output as a Whisper "prompt": keeps names and spelling consistent between segments (cloud engine). */
function promptFrom(history, key) {
  const parts = history.slice(-3).map((h) => h[key]).filter(Boolean);
  let p = parts.join(' ');
  if (p.length > 220) p = p.slice(-220);
  return p;
}
