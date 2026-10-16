import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, isHallucination, buildPrompt, pickTranslator, sttTranscribe, translateTexts, testOllama, testLocalSpeech, langName } from '../lib/providers.js';
import { liveBlocker, translateBlocker, engineLabel, usesTranscribeThenTranslate, DEFAULTS } from '../lib/settings.js';
import { encodeWav } from '../lib/audio.js';
import { startMockApi } from './mock-api.mjs';

const wav = () => new Blob([encodeWav(new Float32Array(1600), 16000)], { type: 'audio/wav' });

test('parseLines accepts {"lines"}, arrays, fenced JSON, numbered text and strips <think>', () => {
  assert.deepEqual(parseLines('{"lines":["a","b"]}', 2), ['a', 'b']);
  assert.deepEqual(parseLines('```json\n{"lines":["a","b\\nc"]}\n```', 2), ['a', 'b\nc']);
  assert.deepEqual(parseLines('Sure! ["x"]', 2), ['x', '']);
  assert.deepEqual(parseLines('1. one\n2. two\n3. three', 2), ['one', 'two']);
  assert.deepEqual(parseLines('<think>hmm {"lines":["no"]}</think>{"lines":["yes"]}', 1), ['yes']);
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

test('pickTranslator: local engine always uses Ollama; cloud follows keys and preference', () => {
  assert.equal(pickTranslator({ engine: 'local' }), 'ollama');
  assert.equal(pickTranslator({}), 'ollama'); // local is the default
  assert.equal(pickTranslator({ engine: 'cloud', textTranslator: 'auto', anthropicKey: 'k', openaiKey: 'k' }), 'claude');
  assert.equal(pickTranslator({ engine: 'cloud', textTranslator: 'auto', openaiKey: 'k' }), 'openai');
  assert.equal(pickTranslator({ engine: 'cloud', textTranslator: 'auto', openaiBaseUrl: 'http://localhost:8000/v1' }), 'openai');
  assert.equal(pickTranslator({ engine: 'cloud', textTranslator: 'openai', anthropicKey: 'k' }), 'none');
  assert.equal(pickTranslator({ engine: 'cloud', textTranslator: 'claude' }), 'none');
});

test('settings helpers: the local engine needs no keys', () => {
  const local = { ...DEFAULTS };
  assert.equal(local.engine, 'local');
  assert.equal(liveBlocker(local), '');
  assert.equal(translateBlocker(local), '');
  assert.equal(usesTranscribeThenTranslate(local), true);
  assert.equal(engineLabel(local), 'Local: Mega-ASR + qwen3:8b');
  const cloud = { ...DEFAULTS, engine: 'cloud' };
  assert.match(liveBlocker(cloud), /OpenAI API key/);
  assert.match(translateBlocker(cloud), /API key/);
  assert.equal(usesTranscribeThenTranslate(cloud), false);
  assert.equal(liveBlocker({ ...cloud, openaiKey: 'k' }), '');
  assert.equal(langName('ja'), 'Japanese');
});

test('local speech: sends the model, a language name and JSON format to the mlx-audio server', async () => {
  const mock = await startMockApi();
  try {
    const settings = { engine: 'local', localSpeechUrl: mock.baseUrl, localSpeechModel: 'mlx-community/Mega-ASR-bf16' };
    const text = await sttTranscribe(wav(), settings, { language: 'ja' });
    assert.equal(text, 'Mock speech result');
    const call = mock.calls.find((c) => c.url === '/v1/audio/transcriptions');
    assert.equal(call.model, 'mlx-community/Mega-ASR-bf16');
    assert.equal(call.language, 'Japanese');
    assert.equal(call.responseFormat, 'json');
    await sttTranscribe(wav(), settings, { language: 'auto' });
    assert.equal(mock.calls.at(-1).language, undefined, 'auto-detect sends no language');
    assert.match(await testLocalSpeech({ ...settings, sourceLang: 'ja' }), /ready/);
  } finally {
    mock.server.close();
  }
});

test('local speech: a stopped server gives a readable error', async () => {
  const settings = { engine: 'local', localSpeechUrl: 'http://127.0.0.1:9/v1' };
  await assert.rejects(sttTranscribe(wav(), settings, { language: 'ja' }), /not reachable.*setup-local\.sh service/);
});

test('Ollama translation: structured output, thinking off, model kept loaded', async () => {
  const mock = await startMockApi();
  try {
    const settings = { engine: 'local', ollamaUrl: mock.origin, ollamaModel: 'qwen3:8b' };
    const out = await translateTexts(['こんにちは', '二行\n目'], { settings, source: 'ja', target: 'en' });
    assert.deepEqual(out, ['EN: こんにちは', 'EN: 二行\n目']);
    const call = mock.calls.find((c) => c.url === '/api/chat');
    assert.equal(call.model, 'qwen3:8b');
    assert.equal(call.think, false);
    assert.deepEqual(call.format.required, ['lines']);
    assert.equal(call.keepAlive, '30m');
    assert.match(await testOllama(settings), /Ollama works: こんにちは、元気ですか？ → EN: こんにちは、元気ですか？/);
  } finally {
    mock.server.close();
  }
});

test('Ollama: missing model and models without a thinking switch', async () => {
  const mock = await startMockApi({ ollamaModels: ['plain-model'], noThinkModels: ['plain-model'] });
  try {
    const missing = { engine: 'local', ollamaUrl: mock.origin, ollamaModel: 'qwen3:8b' };
    await assert.rejects(translateTexts(['a'], { settings: missing }), /not downloaded yet\. Run: ollama pull qwen3:8b/);
    await assert.rejects(testOllama(missing), /not downloaded yet/);
    const plain = { engine: 'local', ollamaUrl: mock.origin, ollamaModel: 'plain-model' };
    assert.deepEqual(await translateTexts(['a'], { settings: plain }), ['EN: a']); // retried without "think"
  } finally {
    mock.server.close();
  }
});
