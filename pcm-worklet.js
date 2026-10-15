// AudioWorklet processor: mixes the captured tab audio down to mono and posts it to the
// offscreen document in ~85 ms chunks (4096 frames at 48 kHz). The output stays silent.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += input[c][i];
      this.buf[this.n++] = s / channels;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(4096);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
