# Subtitle Overlay — Chrome / Brave extension

Overlay English subtitles on any video playing in the browser, two ways:

1. **Subtitle file** — load an `.srt`, `.vtt` or `.ass` file and it is drawn over the video in sync with playback.
   Japanese files are translated to English automatically (Claude, or OpenAI) and the translation is cached per file.
2. **Live subtitles** — the extension captures the tab's audio, sends it to OpenAI Whisper a few seconds at a time and shows
   the English translation over the video, a few seconds behind the speech. A bilingual mode shows the Japanese transcript
   above the English.

It works on any site that plays HTML5 `<video>` (YouTube, Netflix, Crunchyroll, Twitch, local files, embedded players…).
The page itself is not modified: the subtitles live in a shadow-DOM overlay that follows the video, including in fullscreen.

## Install (unpacked)

1. Chrome: open `chrome://extensions`. Brave: open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`Subtitles Extension`).
4. The settings page opens. Paste your API key(s) (see below) and click **Save**.
5. Pin the extension (puzzle-piece icon → pin) so the popup is one click away.

After editing the code, press the reload icon on the extension's card and reload the video tab.

## API keys

| Provider | Key looks like | Used for | Cost (list price) |
| --- | --- | --- | --- |
| OpenAI | `sk-…` | Live subtitles: speech recognition with Whisper. Also text translation if you prefer it. | whisper-1: about $0.36 per hour of video |
| Anthropic | `sk-ant-…` | Translating subtitle files and the live transcript with Claude. | claude-opus-5-5 $4 / $20 per million input / output tokens; claude-sonnet-5-5 $2 / $10; claude-haiku-5-5 $0.10 / $0.50. A full-length film is a few tens of thousands of tokens — well under a dollar even with Opus. |

- Live subtitles always need the OpenAI key (or a local OpenAI-compatible speech server — see *Privacy*).
- File translation works with either key. With both, Claude is used unless you change *Translate with* in settings.
- The Claude model defaults to `claude-opus-5-5` for quality. For live mode, `claude-haiku-5-5` is roughly 40× cheaper and
  noticeably faster; set it in **Settings → Claude model**.

## Using it

### Subtitle file

1. Open the video, click the extension icon.
2. **Load .srt / .vtt / .ass** (or drop the file onto the popup). UTF-8, UTF-16 and Shift_JIS files are all handled.
3. If the file is Japanese and *Translate Japanese files automatically* is on, the Japanese lines show immediately and switch
   to English as each batch is translated (progress is shown on the video). Use **Translate to English** to do it by hand.
4. **Delay** shifts the timing: add delay when subtitles show before the speech. **Size** and **Height** style the text.
   *Show the original text too* puts the Japanese line above the English one.
5. Subtitles survive reloads of the same page. **Clear**, or navigating to another video, removes them.

### Live subtitles

1. Open the video tab, click the extension icon, then **Start live subtitles**. The tab shows a capture indicator; you keep
   hearing the audio.
2. A red **Live** pill appears at the top-right of the video; it turns amber while a segment is being translated.
3. Subtitles appear roughly 2–8 seconds after the speech: the audio is cut at pauses into 1.5–7 second segments (adjustable
   in settings). Every segment is also placed on the video timeline, so seeking back shows it again.
4. **Stop** in the popup, or just close the tab.

Pipelines (**Settings → Live subtitles**):

- **Whisper translate** (default) — one Whisper call that returns English directly. Fastest and cheapest.
- **Transcribe + translate** — Whisper returns the Japanese, then Claude (or OpenAI) translates it using the previous lines
  as context. Better translations, bilingual display, any target language. Adds about a second.

## How it works

- `content.js` runs in every frame, picks the main video (largest, preferably playing) and draws the active cues in a
  shadow-DOM overlay positioned over it each animation frame. It moves itself into the fullscreen element when needed.
- `popup.js` parses subtitle files locally (`lib/subtitles.js`) and hands the cues to `background.js`, which stores them per
  tab in session storage, forwards them to the page, and runs translations in batches of 25 lines (`lib/providers.js`).
- Live mode: the popup asks for a tab-capture stream id; `background.js` opens an offscreen document (`offscreen.js`) that
  captures the tab audio with `getUserMedia`, plays it back so you still hear it, mixes it down to 16 kHz mono
  (`pcm-worklet.js`, `lib/audio.js`), cuts it at pauses with an energy-based voice-activity detector, encodes WAV and calls
  the speech API. Each result carries the wall-clock time of its audio; the content script maps that onto the video
  timeline using the playback samples it keeps, so cues also work after seeking.
- Common Whisper hallucinations on silence ("Thank you for watching", subtitle credits, repeated syllables) are filtered.

## Privacy

- Subtitle files never leave the browser except the text sent to the translation provider you configured.
- Live mode sends short WAV audio segments (16 kHz mono) to the speech API and nothing else; nothing is recorded or kept.
- Keys are stored in `chrome.storage.local` for this browser profile. The extension can only call `api.openai.com`,
  `api.anthropic.com` and `localhost` / `127.0.0.1` (see `host_permissions` in `manifest.json`).
- To keep audio on your machine, run an OpenAI-compatible speech server such as *speaches* (formerly
  faster-whisper-server) and set **API base URL** to it, e.g. `http://localhost:8000/v1`, with the model name it serves.
  The key is then optional.

## Limitations

- Live subtitles lag the speech by several seconds: segment length plus API time. Lower *Longest segment* for less lag at
  the cost of some accuracy, and prefer `whisper-1` for the lowest latency.
- Live mode captures one tab at a time; starting it on another tab moves it there.
- `tabCapture` only works for the tab the popup was opened on. If you see "Extension has not been invoked for the current
  page", click the icon while the video tab is active and press Start again.
- A player that fullscreens the bare `<video>` element (rather than a container) cannot show overlays. Most players use a
  container, so this is rare.
- Picture-in-picture windows are not covered.

## Development

- `npm test` — unit tests for the subtitle parser, the audio pipeline and the provider helpers (Node 18+, no dependencies).
- `node tools/make-icons.js` — regenerates the icons.
- Test page without the extension: `python3 -m http.server 8791` in this folder, then open
  <http://localhost:8791/test/page.html>. `content.js` runs there as a plain script and the buttons drive the overlay.
- `node test/e2e.mjs` — loads the unpacked extension in Chromium through Playwright and checks the whole file → popup →
  background → overlay path (parsing, batch translation against a mock API, delay, reload persistence, fullscreen, clear).
  Run `npm i -D playwright` first, or point `PLAYWRIGHT_DIR` at a project that already has it. Live audio capture cannot be
  driven this way because `tabCapture` needs a real click on the extension icon.

```
manifest.json      MV3 manifest (permissions: storage, tabCapture, offscreen, activeTab, scripting)
background.js      service worker: message routing, per-tab state, file translation
content.js         overlay renderer (all frames)
offscreen.html/js  tab-audio capture, segmenting and speech API calls
pcm-worklet.js     AudioWorklet that mixes the capture down to mono chunks
popup.html/js      file loading, live start/stop, timing & display controls
options.html/js    API keys, models, languages, segmenting
lib/settings.js    defaults + storage helpers
lib/subtitles.js   SRT / VTT / ASS parsing, encoding detection
lib/audio.js       resampler, WAV encoder, voice-activity segmenter
lib/providers.js   OpenAI speech + Claude / OpenAI translation, hallucination filter
test/              unit tests, fixtures and the standalone test page
```
