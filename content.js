// Content script: draws subtitles over the main <video> on the page.
// Runs in every frame (players are often embedded in iframes). It stays idle until it receives cues
// or a live-subtitles state from the extension. Outside the extension (the test page) it exposes
// window.__subtitleOverlay so the overlay can be driven directly.
(() => {
  'use strict';
  if (window.__subtitleOverlay) return;

  const IS_EXT = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const DEFAULT_DISPLAY = { fontScale: 4.5, bottomPct: 6, boxOpacity: 0.6, showOriginal: false };
  const DRAFT_TTL_MS = 8000; // a draft that is never finalized disappears after this long
  const CLOCK_EVENTS = ['timeupdate', 'seeking', 'seeked', 'play', 'playing', 'pause', 'ratechange', 'waiting'];

  const CSS = `
:host { all: initial; }
.wrap { position: fixed; left: 0; top: 0; width: 0; height: 0; overflow: visible; pointer-events: none; z-index: 2147483647;
  --size: 24px; --bottom: 6%; --box: 0.6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Hiragino Sans",
    "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", "Noto Sans CJK JP", sans-serif; }
.cue { position: absolute; left: 50%; bottom: var(--bottom); transform: translateX(-50%); width: max-content; max-width: 92%;
  display: flex; flex-direction: column; align-items: center; gap: 0.12em; font-size: var(--size); }
.line { display: inline-block; box-sizing: border-box; max-width: 100%; padding: 0.1em 0.45em; border-radius: 0.22em;
  background: rgba(0, 0, 0, var(--box)); color: #fff; font-weight: 600; line-height: 1.32; text-align: center;
  white-space: pre-wrap; overflow-wrap: anywhere; letter-spacing: 0.005em;
  text-shadow: 0 0 0.09em rgba(0, 0, 0, .95), 0 0.07em 0.14em rgba(0, 0, 0, .9); }
.line.orig { font-size: 0.72em; font-weight: 500; color: #e6e6e6; }
.line.draft { color: #c9c9c9; font-style: italic; font-weight: 500; background: rgba(0, 0, 0, calc(var(--box) * 0.75)); }
.line.orig.draft { color: #b5b5b5; }
.status, .pill { position: absolute; top: 10px; font-size: 12px; line-height: 1.4; font-weight: 500; color: #fff;
  background: rgba(0, 0, 0, .65); padding: 3px 9px; border-radius: 999px; max-width: 60%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .92; display: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
.status { left: 10px; }
.status.on { display: block; }
.status.error { background: rgba(165, 30, 30, .9); }
.pill { right: 10px; align-items: center; gap: 6px; }
.pill.on { display: inline-flex; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff5252; box-shadow: 0 0 6px #ff5252; }
.pill.translating .dot { background: #ffb020; box-shadow: 0 0 6px #ffb020; }
`;

  const state = {
    enabled: false,
    video: null,
    name: '',
    cues: [], // from a subtitle file: { start, end, text, original? }
    liveCues: [], // from live mode, mapped onto the video timeline: { id, start, end, text, original }
    recentLive: [], // [{ cue, shownAt, hold }] – live lines as they arrive; the last two stay up while fresh
    draft: null, // { segId, at, cue } – grey preview of the line still being spoken
    finalSegs: new Set(), // segments whose final line arrived; their late drafts are ignored
    delay: 0, // seconds; subtitles are looked up at currentTime - delay
    liveOn: false,
    liveState: '',
    display: { ...DEFAULT_DISPLAY },
    status: null, // { text, level, until }
    clock: [], // wall-clock ↔ video-time samples, for live cues
    renderKey: '',
    pageKey: pageKey(),
    raf: 0,
    timer: 0,
  };

  let host = null;
  let shadow = null;
  let wrap = null;
  let cueBox = null;
  let statusEl = null;
  let pillEl = null;

  function pageKey() {
    return location.origin + location.pathname + location.search;
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  // ---------------------------------------------------------------- overlay DOM

  function ensureDom() {
    if (host) return true;
    try {
      host = el('div');
      host.setAttribute('data-subtitle-overlay', '');
      host.style.cssText =
        'all:initial!important;display:block!important;position:fixed!important;left:0!important;top:0!important;' +
        'width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;';
      shadow = host.attachShadow({ mode: 'open' });
      let styled = false;
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        shadow.adoptedStyleSheets = [sheet]; // CSSOM styling is not subject to the page's CSP
        styled = true;
      } catch {
        /* older engine */
      }
      if (!styled) {
        const st = el('style');
        st.textContent = CSS;
        shadow.appendChild(st);
      }
      wrap = el('div', 'wrap');
      cueBox = el('div', 'cue');
      statusEl = el('div', 'status');
      pillEl = el('div', 'pill');
      pillEl.append(el('span', 'dot'), el('span', 'label'));
      wrap.append(cueBox, statusEl, pillEl);
      shadow.appendChild(wrap);
      mount();
      return true;
    } catch {
      host = null;
      return false;
    }
  }

  /** Keep the overlay inside the fullscreen element (only that subtree is visible in fullscreen). */
  function mount() {
    if (!host) return;
    const fs = document.fullscreenElement;
    const parent = fs && fs !== host && fs.tagName !== 'VIDEO' ? fs : document.documentElement || document.body;
    if (parent && host.parentNode !== parent) parent.appendChild(host);
  }

  // ---------------------------------------------------------------- video discovery

  function collectVideos() {
    const out = Array.from(document.querySelectorAll('video'));
    if (out.length) return out;
    const walk = (root, depth) => {
      if (depth > 4) return;
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          out.push(...node.shadowRoot.querySelectorAll('video'));
          walk(node.shadowRoot, depth + 1);
        }
      }
    };
    try {
      walk(document, 0); // rare: players inside open shadow roots
    } catch {
      /* ignore */
    }
    return out;
  }

  /** The video to subtitle: the biggest visible one, preferring the one that is playing. */
  function findVideo() {
    let best = null;
    let bestScore = 0;
    for (const v of collectVideos()) {
      const r = v.getBoundingClientRect();
      if (r.width < 120 || r.height < 70) continue;
      const cs = getComputedStyle(v);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const visible = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      let score = r.width * r.height * (visible ? 1 : 0.1);
      if (!v.paused && !v.ended && v.readyState >= 2) score *= 4;
      if (v === state.video) score *= 1.5; // stickiness
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  function attach(v) {
    if (state.video === v) return;
    if (state.video) for (const ev of CLOCK_EVENTS) state.video.removeEventListener(ev, sampleClock);
    state.video = v;
    state.clock = [];
    state.renderKey = '';
    if (v) {
      for (const ev of CLOCK_EVENTS) v.addEventListener(ev, sampleClock, { passive: true });
      sampleClock();
    }
  }

  // ---------------------------------------------------------------- wall clock ↔ video time

  function sampleClock() {
    const v = state.video;
    if (!v) return;
    state.clock.push({ wall: Date.now(), ct: v.currentTime, playing: !v.paused && !v.ended, rate: v.playbackRate || 1 });
    if (state.clock.length > 600) state.clock.splice(0, 200);
  }

  /** Video time that was playing at wall-clock time `wall` (ms), or null if unknown. */
  function videoTimeAt(wall) {
    const c = state.clock;
    if (!c.length) return null;
    let lo = 0;
    let hi = c.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].wall <= wall) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (idx === -1) {
      const s = c[0];
      return s.playing ? Math.max(0, s.ct - ((s.wall - wall) / 1000) * s.rate) : s.ct;
    }
    const s = c[idx];
    if (!s.playing) return s.ct;
    let dt = (wall - s.wall) / 1000;
    const nxt = c[idx + 1];
    if (nxt) dt = Math.min(dt, (nxt.wall - s.wall) / 1000);
    return s.ct + dt * s.rate;
  }

  // ---------------------------------------------------------------- cues

  function setCues(cues, name) {
    enable();
    state.cues = (cues || [])
      .map((c) => ({ start: Number(c.start), end: Number(c.end), text: String(c.text ?? ''), original: c.original ? String(c.original) : '' }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end))
      .sort((a, b) => a.start - b.start);
    state.name = name || '';
    state.renderKey = '';
  }

  function patchCues({ index, texts, originals }) {
    if (!Array.isArray(texts)) return;
    const base = Number(index) || 0;
    for (let i = 0; i < texts.length; i++) {
      const c = state.cues[base + i];
      if (!c) continue;
      if (originals && originals[i] != null && !c.original) c.original = String(originals[i]);
      if (texts[i]) c.text = String(texts[i]);
    }
    state.renderKey = '';
  }

  function addLiveCue(cue) {
    if (!cue) return;
    if (cue.segId != null) {
      state.finalSegs.add(cue.segId);
      if (state.finalSegs.size > 300) state.finalSegs.delete(state.finalSegs.values().next().value);
      if (state.draft && state.draft.segId === cue.segId) {
        state.draft = null; // the final line replaces its draft (or removes it when nothing usable was heard)
        state.renderKey = '';
      }
    }
    if (!cue.text) return;
    state.liveOn = true;
    enable();
    const start = videoTimeAt(cue.wallStart);
    const end = videoTimeAt(cue.wallEnd);
    const c = {
      id: cue.id,
      text: String(cue.text),
      original: cue.original ? String(cue.original) : '',
      wallStart: cue.wallStart,
      wallEnd: cue.wallEnd,
      start: start == null ? -1 : start,
      end: end == null ? -1 : Math.max(end, (start ?? 0) + 0.6),
    };
    state.liveCues.push(c);
    state.liveCues.sort((a, b) => a.start - b.start);
    if (state.liveCues.length > 3000) state.liveCues.shift();
    const dur = Math.max(0, (cue.wallEnd - cue.wallStart) / 1000);
    state.recentLive.push({ cue: c, shownAt: Date.now(), hold: Math.min(10000, Math.max(3500, dur * 1000 + 2500)) });
    state.recentLive.sort((a, b) => a.cue.wallStart - b.cue.wallStart); // finals can finish out of order
    if (state.recentLive.length > 4) state.recentLive.shift();
    state.renderKey = '';
  }

  /** A grey preview of the line still being spoken; replaced when the final line for that segment arrives. */
  function addLiveDraft(d) {
    if (!d || !d.text) return;
    if (d.segId != null && state.finalSegs.has(d.segId)) return; // its final line is already up
    if (state.draft && d.segId != null && state.draft.segId != null && d.segId < state.draft.segId) return; // older
    state.liveOn = true;
    enable();
    state.draft = {
      segId: d.segId,
      at: Date.now(),
      cue: { start: -1, end: -1, text: String(d.text), original: d.original ? String(d.original) : '', draft: true },
    };
    state.renderKey = '';
  }

  function clearLive() {
    state.recentLive = [];
    state.draft = null;
  }

  function clearAll() {
    state.cues = [];
    state.liveCues = [];
    clearLive();
    state.name = '';
    state.renderKey = '';
    if (!state.liveOn) disable();
  }

  function showStatus(text, level = 'info', ttl = 4000) {
    enable();
    state.status = text ? { text: String(text), level, until: Date.now() + (Number(ttl) || 4000) } : null;
  }

  function onLiveState({ state: s, detail }) {
    if (s === 'stopped' || s === 'ended') {
      state.liveOn = false;
      state.liveState = '';
      clearLive();
      if (!state.cues.length && !state.liveCues.length) disable();
      return;
    }
    state.liveOn = true;
    state.liveState = s;
    enable();
    if (s === 'error') showStatus(detail || 'Live subtitles error', 'error', 8000);
  }

  function applyDisplay(s) {
    if (!s) return;
    for (const k of Object.keys(DEFAULT_DISPLAY)) if (s[k] !== undefined) state.display[k] = s[k];
    state.renderKey = '';
  }

  // ---------------------------------------------------------------- rendering

  function render() {
    if (!host || !wrap) return;
    const v = state.video;
    if (!v || !v.isConnected) {
      wrap.style.display = 'none';
      return;
    }
    const r = v.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    wrap.style.left = `${r.left}px`;
    wrap.style.top = `${r.top}px`;
    wrap.style.width = `${r.width}px`;
    wrap.style.height = `${r.height}px`;
    const d = state.display;
    wrap.style.setProperty('--size', `${Math.max(12, (r.height * (Number(d.fontScale) || 4.5)) / 100).toFixed(1)}px`);
    wrap.style.setProperty('--bottom', `${Number(d.bottomPct ?? 6)}%`);
    wrap.style.setProperty('--box', String(d.boxOpacity ?? 0.6));

    const t = v.currentTime - state.delay;
    const active = [];
    for (const c of state.cues) {
      if (c.start > t) break;
      if (t < c.end) active.push(c);
    }
    for (const c of state.liveCues) {
      if (c.start > t) break;
      if (c.start >= 0 && t < c.end) active.push(c);
    }
    const now = Date.now();
    for (const r of state.recentLive.filter((x) => now - x.shownAt < x.hold).slice(-2)) {
      if (!active.includes(r.cue)) active.push(r.cue);
    }
    let shown = active.slice(-3);
    const dr = state.draft;
    if (dr && now - dr.at < DRAFT_TTL_MS && !state.finalSegs.has(dr.segId)) shown = [...shown.slice(-2), dr.cue];
    const key =
      shown.map((c) => `${c.start}|${c.text}|${c.original}|${c.draft ? 'd' : ''}`).join('\n') + (d.showOriginal ? '|o' : '');
    if (key !== state.renderKey) {
      state.renderKey = key;
      drawCues(shown, !!d.showOriginal);
    }
    drawChrome();
  }

  function drawCues(cues, showOriginal) {
    while (cueBox.firstChild) cueBox.removeChild(cueBox.firstChild);
    for (const c of cues) {
      const extra = c.draft ? ' draft' : '';
      if (showOriginal && c.original && c.original !== c.text) {
        const o = el('div', 'line orig' + extra);
        o.textContent = c.original;
        cueBox.appendChild(o);
      }
      const l = el('div', 'line' + extra);
      l.textContent = c.text;
      cueBox.appendChild(l);
    }
  }

  function drawChrome() {
    const on = state.liveOn;
    const cls = 'pill' + (on ? ' on' : '') + (state.liveState === 'translating' ? ' translating' : '');
    if (pillEl.className !== cls) pillEl.className = cls;
    if (on) {
      const label = state.liveState === 'translating' ? 'Translating…' : state.liveState === 'error' ? 'Live · error' : 'Live';
      if (pillEl.lastChild.textContent !== label) pillEl.lastChild.textContent = label;
    }
    const s = state.status;
    if (s && Date.now() < s.until) {
      const scls = 'status on' + (s.level === 'error' ? ' error' : '');
      if (statusEl.className !== scls) statusEl.className = scls;
      if (statusEl.textContent !== s.text) statusEl.textContent = s.text;
    } else {
      if (s) state.status = null;
      if (statusEl.className !== 'status') statusEl.className = 'status';
    }
  }

  // ---------------------------------------------------------------- lifecycle

  function enable() {
    if (state.enabled) return;
    if (!ensureDom()) return;
    state.enabled = true;
    tick();
    state.timer = setInterval(tick, 1000);
    const loop = () => {
      if (!state.enabled) return;
      try {
        render();
      } catch {
        /* keep the loop alive */
      }
      state.raf = requestAnimationFrame(loop);
    };
    state.raf = requestAnimationFrame(loop);
    document.addEventListener('fullscreenchange', mount, true);
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    clearInterval(state.timer);
    cancelAnimationFrame(state.raf);
    document.removeEventListener('fullscreenchange', mount, true);
    attach(null);
    if (host) host.remove();
    host = shadow = wrap = cueBox = statusEl = pillEl = null;
  }

  function tick() {
    const pk = pageKey();
    if (pk !== state.pageKey) {
      // In-page navigation (YouTube, etc.): the old subtitles do not belong to the new video.
      state.pageKey = pk;
      state.cues = [];
      state.liveCues = [];
      clearLive();
      state.name = '';
      state.renderKey = '';
      if (IS_EXT) send({ target: 'background', type: 'cues:clear' });
    }
    const v = findVideo();
    if (v !== state.video) attach(v);
    mount();
    render(); // animation frames pause in background tabs; keep the overlay consistent anyway
  }

  // ---------------------------------------------------------------- extension messaging

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  if (IS_EXT) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || (msg.target && msg.target !== 'content')) return;
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true });
          return;
        case 'get-status': {
          const v = state.video || findVideo();
          if (!v) return; // only frames that have a video answer, so the popup hears from the right frame
          sendResponse({
            hasVideo: true,
            enabled: state.enabled,
            cueCount: state.cues.length,
            liveCount: state.liveCues.length,
            delay: state.delay,
            name: state.name,
            translated: state.cues.some((c) => !!c.original),
            liveOn: state.liveOn,
            liveState: state.liveState,
            videoTime: v.currentTime,
            videoDuration: v.duration,
            frame: location.href,
          });
          return;
        }
        case 'set-cues':
          setCues(msg.cues, msg.name);
          break;
        case 'patch-cues':
          patchCues(msg);
          break;
        case 'clear':
          clearAll();
          break;
        case 'set-delay':
          state.delay = Number(msg.delay) || 0;
          state.renderKey = '';
          break;
        case 'live-cue':
          addLiveCue(msg.cue);
          break;
        case 'live-draft':
          addLiveDraft(msg.draft);
          break;
        case 'live-state':
          onLiveState(msg);
          break;
        case 'status':
          showStatus(msg.text, msg.level, msg.ttl);
          break;
        default:
          return;
      }
      sendResponse({ ok: true });
    });

    try {
      chrome.storage.local.get('settings').then((r) => applyDisplay(r.settings)).catch(() => {});
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) applyDisplay(changes.settings.newValue);
      });
    } catch {
      /* storage unavailable */
    }

    // Ask the background whether this tab already has subtitles (e.g. after a reload).
    send({ target: 'background', type: 'content:hello', url: location.href }).then((r) => {
      if (!r) return;
      if (Array.isArray(r.cues) && r.cues.length) setCues(r.cues, r.name);
      if (typeof r.delay === 'number') state.delay = r.delay;
      if (r.live) onLiveState({ state: 'listening' });
    });
  }

  window.__subtitleOverlay = {
    setCues,
    patchCues,
    clearAll,
    addLiveCue,
    addLiveDraft,
    onLiveState,
    showStatus,
    setDelay: (d) => {
      state.delay = Number(d) || 0;
      state.renderKey = '';
    },
    setDisplay: applyDisplay,
    enable,
    disable,
    findVideo,
    videoTimeAt,
    get state() {
      return state;
    },
  };
})();
