import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, parseTime, decodeSubtitleBytes, cleanText, looksJapanese, hashString, formatTime } from '../lib/subtitles.js';

test('parseTime handles SRT, short VTT and ASS centiseconds', () => {
  assert.equal(parseTime('01:02:03,456'), 3723.456);
  assert.equal(parseTime('02:03.500'), 123.5);
  assert.equal(parseTime('0:00:01.50'), 1.5);
  assert.equal(parseTime(' 00:00:02,000 X1:10'), 2);
  assert.equal(parseTime('nope'), null);
});

test('SRT: BOM, CRLF, tags, positioning, empty blocks', () => {
  const srt =
    '﻿1\r\n00:00:01,000 --> 00:00:02,500 X1:0 X2:0\r\n<i>こんにちは</i>\r\n{\\an8}世界\r\n\r\n' +
    '2\r\n00:00:03,000 --> 00:00:04,000\r\n\r\n' +
    '3\r\n00:00:05,000 --> 00:00:06,000\r\nLast <b>line</b>\r\n';
  const { format, cues } = parseSubtitles(srt, 'movie.srt');
  assert.equal(format, 'srt');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2.5, text: 'こんにちは\n世界' });
  assert.deepEqual(cues[1], { start: 5, end: 6, text: 'Last line' });
});

test('VTT: header, NOTE blocks, cue identifiers, voice and timestamp tags, entities', () => {
  const vtt =
    'WEBVTT\nKind: captions\n\nNOTE this is a note --> ignore it\n\n' +
    'intro\n00:01.000 --> 00:02.000 align:start line:0%\n<v Speaker>Hello <00:01.500>there</v>\n\n' +
    '00:00:03.000 --> 00:00:04.000\nSecond &amp; last\n';
  const { format, cues } = parseSubtitles(vtt, 'captions.vtt');
  assert.equal(format, 'vtt');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2, text: 'Hello there' });
  assert.equal(cues[1].text, 'Second & last');
});

test('ASS: Format order, commas in text, \\N breaks, override tags, comments, sorting, duplicates', () => {
  const ass =
    '[Script Info]\nTitle: t\n\n[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:05.00,0:00:06.50,Default,,0,0,0,,{\\an8}Later, with a comma\\Nsecond line\n' +
    'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}First{\\i0}\n' +
    'Dialogue: 1,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}First{\\i0}\n' +
    'Comment: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,ignored\n';
  const { format, cues } = parseSubtitles(ass, 'show.ass');
  assert.equal(format, 'ass');
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 1, end: 2, text: 'First' });
  assert.deepEqual(cues[1], { start: 5, end: 6.5, text: 'Later, with a comma\nsecond line' });
});

test('format detection falls back sensibly', () => {
  assert.equal(parseSubtitles('WEBVTT\n\n00:01.000 --> 00:02.000\nx').format, 'vtt');
  assert.equal(parseSubtitles('1\n00:00:01,000 --> 00:00:02,000\nx', 'whatever.txt').format, 'srt');
  assert.equal(parseSubtitles('[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,x').cues[0].text, 'x');
});

test('cleanText strips markup but keeps line breaks and braces that are not tags', () => {
  assert.equal(cleanText(' <font color="#fff">A</font><br>B  \n\n {not a tag} '), 'A\nB\n{not a tag}');
});

test('decodeSubtitleBytes: UTF-8 BOM, UTF-16LE BOM and Shift_JIS fallback', () => {
  assert.equal(decodeSubtitleBytes(new TextEncoder().encode('﻿こんにちは')), 'こんにちは');
  const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
  assert.equal(decodeSubtitleBytes(utf16), 'AB');
  const sjis = new Uint8Array([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]); // こんにちは
  assert.equal(decodeSubtitleBytes(sjis), 'こんにちは');
});

test('looksJapanese, hashString, formatTime', () => {
  assert.equal(looksJapanese('今日はいい天気ですね'), true);
  assert.equal(looksJapanese('What a lovely day'), false);
  assert.equal(looksJapanese('Mixed テキスト with 少し'), true);
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.equal(hashString('').length, 8);
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(65), '1:05');
});
