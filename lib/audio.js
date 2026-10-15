// Audio helpers for live mode: resampling, WAV encoding and speech segmentation.
// Pure JS (no DOM) so everything here can be unit-tested in Node.

export function concat(a, b) {
  if (!a || !a.length) return b instanceof Float32Array ? b : new Float32Array(b);
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Downsampler (e.g. 48 kHz → 16 kHz) that keeps leftover samples between calls, so nothing drifts. */
export class Resampler {
  constructor(fromRate, toRate) {
    this.ratio = fromRate / toRate;
    this.carry = new Float32Array(0);
  }

  process(input) {
    if (this.ratio === 1) return input;
    if (this.ratio < 1) return upsampleLinear(input, this.ratio);
    const data = concat(this.carry, input);
    const outLen = Math.floor(data.length / this.ratio);
    const out = new Float32Array(outLen);
    let consumed = 0;
    for (let i = 0; i < outLen; i++) {
      const s = Math.floor(i * this.ratio);
      const e = Math.min(data.length, Math.max(s + 1, Math.floor((i + 1) * this.ratio)));
      let sum = 0;
      for (let j = s; j < e; j++) sum += data[j];
      out[i] = sum / (e - s); // box-filter average: cheap anti-aliasing, plenty for speech recognition
      consumed = e;
    }
    this.carry = data.slice(consumed);
    return out;
  }
}

function upsampleLinear(input, ratio) {
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[Math.min(j, input.length - 1)];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Float32 mono samples → 16-bit PCM WAV (ArrayBuffer). */
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * Cuts a continuous audio stream into speech segments for the speech API.
 * - A segment ends at a pause (silenceMs of quiet after at least minSegSec), or when it reaches maxSegSec.
 * - Leading silence is dropped (a short pre-roll is kept so word onsets are not clipped).
 * - Segments that are almost all silence are discarded (Whisper tends to hallucinate on silence).
 * Every segment carries wall-clock times so the page can map it back onto the video timeline.
 */
export class Segmenter {
  constructor(opts = {}) {
    this.sr = opts.sampleRate ?? 16000;
    this.frameMs = opts.frameMs ?? 20;
    this.frameLen = Math.round((this.sr * this.frameMs) / 1000);
    this.minFrames = Math.max(1, Math.round(((opts.minSegSec ?? 1.5) * 1000) / this.frameMs));
    this.maxFrames = Math.max(this.minFrames, Math.round(((opts.maxSegSec ?? 7) * 1000) / this.frameMs));
    this.silenceFrames = Math.max(1, Math.round((opts.silenceMs ?? 600) / this.frameMs));
    this.preRollFrames = Math.round((opts.preRollMs ?? 240) / this.frameMs);
    this.trailFrames = Math.round((opts.trailMs ?? 300) / this.frameMs);
    this.baseThreshold = opts.threshold ?? 0.01;
    this.minSpeechRatio = opts.minSpeechRatio ?? 0.15;
    this.onSegment = opts.onSegment || (() => {});

    this.pending = new Float32Array(0);
    this.totalSamples = 0;
    this.wallEnd = 0;
    this.noise = 0.003;
    this.preRoll = [];
    this.seg = [];
    this.segSpeech = 0;
    this.trailingSilence = 0;
  }

  get threshold() {
    return Math.max(this.baseThreshold, this.noise * 3);
  }

  /** Feed samples (Float32Array at this.sr). wallEnd = Date.now() at which the last sample was heard. */
  push(samples, wallEnd) {
    const data = concat(this.pending, samples);
    this.wallEnd = wallEnd ?? Date.now();
    this.totalSamples += samples.length;
    let offset = 0;
    while (data.length - offset >= this.frameLen) {
      const frame = data.subarray(offset, offset + this.frameLen);
      offset += this.frameLen;
      const endIndex = this.totalSamples - (data.length - offset); // absolute index just after this frame
      this._frame(frame, endIndex);
    }
    this.pending = data.slice(offset);
  }

  _frame(frame, endIndex) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const speech = rms > this.threshold;
    if (!speech) this.noise = this.noise * 0.98 + rms * 0.02; // follow the noise floor slowly
    const f = { samples: new Float32Array(frame), speech, endIndex };

    if (this.seg.length === 0) {
      if (!speech) {
        this.preRoll.push(f);
        if (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
        return;
      }
      this.seg = this.preRoll;
      this.preRoll = [];
      this.segSpeech = 0;
      this.trailingSilence = 0;
    }

    this.seg.push(f);
    if (speech) {
      this.segSpeech++;
      this.trailingSilence = 0;
    } else {
      this.trailingSilence++;
    }
    const n = this.seg.length;
    if ((n >= this.minFrames && this.trailingSilence >= this.silenceFrames) || n >= this.maxFrames) this._emit();
  }

  _emit() {
    const frames = this.seg;
    const cut = frames.length - Math.max(0, this.trailingSilence - this.trailFrames);
    const kept = frames.slice(0, cut);
    this.seg = [];
    this.segSpeech = 0;
    this.trailingSilence = 0;
    if (!kept.length) return;
    let speechFrames = 0;
    for (const f of kept) if (f.speech) speechFrames++;
    const speechRatio = speechFrames / kept.length; // measured on the audio that is actually sent
    if (speechRatio < this.minSpeechRatio) return;

    let total = 0;
    for (const f of kept) total += f.samples.length;
    const out = new Float32Array(total);
    let o = 0;
    for (const f of kept) {
      out.set(f.samples, o);
      o += f.samples.length;
    }
    const startIndex = kept[0].endIndex - kept[0].samples.length;
    const endIndex = kept[kept.length - 1].endIndex;
    this.onSegment({
      samples: out,
      sampleRate: this.sr,
      duration: total / this.sr,
      speechRatio,
      wallStart: this.wallOf(startIndex),
      wallEnd: this.wallOf(endIndex),
    });
  }

  wallOf(sampleIndex) {
    return this.wallEnd - ((this.totalSamples - sampleIndex) / this.sr) * 1000;
  }

  /** Emit whatever is buffered (used when capture stops). */
  flush() {
    if (this.seg.length >= this.minFrames / 2) this._emit();
    else {
      this.seg = [];
      this.segSpeech = 0;
      this.trailingSilence = 0;
    }
  }
}
