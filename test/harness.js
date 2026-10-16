// Drives content.js in standalone mode on test/page.html.
import { parseSubtitles } from '../lib/subtitles.js';

const $ = (id) => document.getElementById(id);
const api = window.__subtitleOverlay;
const info = (t) => ($('info').textContent = t);

const srtText = await (await fetch('fixtures/sample.ja.srt')).text();
const { cues } = parseSubtitles(srtText, 'sample.ja.srt');
window.harness = { cues, api };

$('loadSrt').onclick = () => {
  api.setCues(cues, 'sample.ja.srt');
  info(`${cues.length} cues loaded`);
};
$('patch').onclick = () => {
  api.patchCues({ index: 0, texts: cues.map((c, i) => `EN ${i + 1}: ${c.text.length} chars`), originals: cues.map((c) => c.text) });
  api.setDisplay({ showOriginal: true });
  info('patched with English + bilingual display');
};
$('live').onclick = () => {
  const now = Date.now();
  api.addLiveCue({ id: `live-${now}`, text: 'A live cue arrived just now.', original: 'ライブ字幕', wallStart: now - 3000, wallEnd: now - 400 });
  api.onLiveState({ state: 'listening' });
  info('live cue added');
};
let segSeq = 1000;
$('draft').onclick = () => {
  const segId = ++segSeq;
  const now = Date.now();
  api.onLiveState({ state: 'listening' });
  api.addLiveDraft({ segId, text: 'I found a new ramen shop near…', original: '駅の近くで新しいラーメン屋を…', wallStart: now - 1500, wallEnd: now });
  info('draft shown; final arrives in 1.5 s');
  setTimeout(() => {
    api.addLiveCue({ id: `live-${segId}`, segId, text: 'I found a new ramen shop near the station.', original: '駅の近くで新しいラーメン屋を見つけた。', wallStart: now - 1500, wallEnd: now + 1500 });
    info('final replaced the draft');
  }, 1500);
};
$('fs').onclick = () => $('player').requestFullscreen();
$('clear').onclick = () => {
  api.onLiveState({ state: 'stopped' });
  api.clearAll();
  info('cleared');
};
