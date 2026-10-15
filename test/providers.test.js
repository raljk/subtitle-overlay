import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, isHallucination, buildPrompt, pickTranslator } from '../lib/providers.js';

test('parseLines accepts {"lines"}, arrays, fenced JSON and numbered text', () => {
  assert.deepEqual(parseLines('{"lines":["a","b"]}', 2), ['a', 'b']);
  assert.deepEqual(parseLines('```json\n{"lines":["a","b\\nc"]}\n```', 2), ['a', 'b\nc']);
  assert.deepEqual(parseLines('Sure! ["x"]', 2), ['x', '']);
  assert.deepEqual(parseLines('1. one\n2. two\n3. three', 2), ['one', 'two']);
  assert.throws(() => parseLines('nothing here', 1));
});

test('isHallucination catches Whisper filler, credits and loops but not real lines', () => {
  assert.equal(isHallucination('Thank you for watching!'), true);
  assert.equal(isHallucination('Thanks for watching.'), true);
  assert.equal(isHallucination('ご視聴ありがとうございました'), true);
  assert.equal(isHallucination('Subtitles by the Amara.org community'), true);
  assert.equal(isHallucination('ha ha ha ha ha ha ha ha ha ha'), true);
  assert.equal(isHallucination('あああああああああああああ'), true);
  assert.equal(isHallucination('...'), true);
  assert.equal(isHallucination(''), true);
  assert.equal(isHallucination("I can't believe you came all this way."), false);
  assert.equal(isHallucination('Thank you, I owe you one.'), false);
  assert.equal(isHallucination('今日は本当にありがとう。助かったよ。'), false);
});

test('buildPrompt numbers entries, escapes line breaks and includes context', () => {
  const { system, user } = buildPrompt(['a\nb', 'c'], 'ja', 'en', [{ original: 'x', text: 'y' }]);
  assert.match(system, /Japanese subtitles into natural, fluent English/);
  assert.match(system, /exactly 2 strings/);
  assert.match(user, /1\. a\\nb\n2\. c/);
  assert.match(user, /- x => y/);
  assert.match(buildPrompt(['q'], 'auto', 'en', []).system, /^You translate subtitles/);
});

test('pickTranslator follows the preference and the available keys', () => {
  assert.equal(pickTranslator({ textTranslator: 'auto', anthropicKey: 'k', openaiKey: 'k' }), 'claude');
  assert.equal(pickTranslator({ textTranslator: 'auto', openaiKey: 'k' }), 'openai');
  assert.equal(pickTranslator({ textTranslator: 'auto', openaiBaseUrl: 'http://localhost:8000/v1' }), 'openai');
  assert.equal(pickTranslator({ textTranslator: 'openai', anthropicKey: 'k' }), 'none');
  assert.equal(pickTranslator({ textTranslator: 'claude' }), 'none');
});
