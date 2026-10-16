// Turns speech segments into subtitle events for live mode. Pure logic (no DOM, no chrome.*), so it can be tested.
//
// - Final segments (a pause ended them, or they hit the length cap) are always processed, oldest first,
//   at most `maxInflight` at a time. If the engines fall behind, the oldest waiting segments are skipped.
// - Draft snapshots (the segment so far, while someone is still talking) are best-effort previews: one at a
//   time, only when no final is waiting, and discarded if that segment's final line is already done.
// - Every final ends with a 'cue' event, empty when nothing usable was heard, so the page can drop the draft.
//
// Events passed to emit():
//   { type: 'cue',   segId, text, original, wallStart, wallEnd }   text '' = nothing to show, clear the draft
//   { type: 'draft', segId, text, original, wallStart, wallEnd }
//   { type: 'state', state: 'translating' | 'listening' }
//   { type: 'error', message }

export class LivePipeline {
  /**
   * @param {object} o
   * @param {(seg, info: {draft: boolean, history: object[]}) => Promise<string>} o.listen  speech → text
   * @param {((text: string, context: object[]) => Promise<string>) | null} o.translate  null when listen returns the target language
   * @param {(text: string) => boolean} [o.isJunk]  filters hallucinations
   * @param {(event: object) => void} o.emit
   */
  constructor({ listen, translate = null, isJunk = () => false, emit, maxInflight = 2, maxQueue = 3, contextSize = 4 }) {
    Object.assign(this, { listen, translate, isJunk, emit, maxInflight, maxQueue, contextSize });
    this.queue = [];
    this.inflight = 0;
    this.draftBusy = false;
    this.finalized = new Set();
    this.history = []; // finals only: [{ original, text }]
    this.lastText = '';
    this.lastOriginal = '';
    this.stopped = false;
    this.busyShown = false;
    this.segments = 0;
    this.drafts = 0;
  }

  stop() {
    this.stopped = true;
    this.queue = [];
  }

  /** A finished segment: always processed (unless skipped because the engines fell behind). */
  final(seg) {
    if (this.stopped) return;
    this.segments++;
    this.queue.push(seg);
    while (this.queue.length > this.maxQueue) this._finish(this.queue.shift(), null); // skipped: clear its draft
    this._pump();
  }

  /** A snapshot of a segment that is still open. Returns true when it was accepted for processing. */
  draft(seg) {
    if (this.stopped || this.draftBusy || this.queue.length || this.inflight >= this.maxInflight) return false;
    if (this.finalized.has(seg.id)) return false;
    this.draftBusy = true;
    this.drafts++;
    this._run(seg, true)
      .catch(() => {}) // a failed draft is not worth an error message; the final will report problems
      .finally(() => {
        this.draftBusy = false;
      });
    return true;
  }

  _pump() {
    while (!this.stopped && this.inflight < this.maxInflight && this.queue.length) {
      const seg = this.queue.shift();
      this.inflight++;
      this._busy();
      this._run(seg, false)
        .then(
          (r) => this._finish(seg, r),
          (e) => {
            this._finish(seg, null);
            if (!this.stopped) this.emit({ type: 'error', message: e?.message || String(e) });
          },
        )
        .finally(() => {
          this.inflight--;
          this._busy();
          this._pump();
        });
    }
  }

  _stale(seg, isDraft) {
    return this.stopped || (isDraft && this.finalized.has(seg.id));
  }

  async _run(seg, isDraft) {
    const heard = String((await this.listen(seg, { draft: isDraft, history: this.history })) || '').trim();
    if (this._stale(seg, isDraft) || !heard || this.isJunk(heard)) return null;
    let text = heard;
    let original = '';
    if (this.translate) {
      if (!isDraft && heard === this.lastOriginal) return null; // the same words twice in a row: an echo
      original = heard;
      text = String((await this.translate(heard, this.history.slice(-this.contextSize))) || '').trim();
      if (this._stale(seg, isDraft)) return null;
    }
    if (!text || this.isJunk(text)) return null;
    if (isDraft) {
      this.emit({ type: 'draft', segId: seg.id, text, original, wallStart: seg.wallStart, wallEnd: seg.wallEnd });
      return null;
    }
    return { text, original };
  }

  _finish(seg, r) {
    this.finalized.add(seg.id);
    if (this.finalized.size > 200) this.finalized.delete(this.finalized.values().next().value);
    if (this.stopped) return;
    const base = { type: 'cue', segId: seg.id, wallStart: seg.wallStart, wallEnd: seg.wallEnd };
    if (r && r.text && r.text !== this.lastText) {
      this.lastText = r.text;
      this.lastOriginal = r.original;
      this.history.push({ original: r.original, text: r.text });
      if (this.history.length > 8) this.history.shift();
      this.emit({ ...base, text: r.text, original: r.original });
    } else {
      this.emit({ ...base, text: '', original: '' });
    }
  }

  _busy() {
    const busy = this.inflight > 0;
    if (busy === this.busyShown || this.stopped) return;
    this.busyShown = busy;
    this.emit({ type: 'state', state: busy ? 'translating' : 'listening' });
  }
}
