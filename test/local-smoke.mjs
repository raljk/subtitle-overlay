// Smoke test of the local engine with the real models (macOS): speaks Japanese sentences with the system
// voice "Kyoko", transcribes them with the speech server (MegaASR) and translates them with Ollama, using the
// same code the extension runs. Usage: node test/local-smoke.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../lib/settings.js';
import { sttTranscribe, translateTexts } from '../lib/providers.js';

const settings = { ...DEFAULTS, engine: 'local' };
const sentences = [
  '今日はとても寒いですね。駅まで一緒に歩きましょうか。',
  '明日の会議は午後三時に始まります。資料を忘れないでください。',
  'ちょっと待って！そのケーキ、私のだよ。',
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-smoke-'));
let failed = 0;
try {
  for (const [i, sentence] of sentences.entries()) {
    const file = path.join(dir, `s${i}.wav`);
    execFileSync('say', ['-v', 'Kyoko', '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', sentence]);
    const blob = new Blob([fs.readFileSync(file)], { type: 'audio/wav' });
    try {
      const t0 = Date.now();
      const heard = await sttTranscribe(blob, settings, { language: 'ja' });
      const t1 = Date.now();
      const [english] = await translateTexts([heard], { settings, source: 'ja', target: 'en' });
      const t2 = Date.now();
      console.log(`\nspoken:     ${sentence}`);
      console.log(`heard:      ${heard}   (${((t1 - t0) / 1000).toFixed(1)} s)`);
      console.log(`translated: ${english}   (${((t2 - t1) / 1000).toFixed(1)} s)`);
      if (!heard || !english) failed++;
    } catch (e) {
      failed++;
      console.log(`\nspoken: ${sentence}\nFAILED: ${e.message}`);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} of ${sentences.length} sentences failed` : `\nall ${sentences.length} sentences worked`);
process.exit(failed ? 1 : 0);
