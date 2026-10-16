# Subtitle Overlay — Chrome / Brave extension

Overlay English subtitles on any video playing in the browser, two ways:

1. **Live subtitles**: the extension listens to the tab's audio, transcribes the Japanese and shows an English translation
   over the video, a few seconds behind the speech.
2. **Subtitle file**: load an `.srt`, `.vtt` or `.ass` file and it is drawn over the video in sync with playback.
   Japanese files are translated to English automatically, and the translation is cached per file.

It works on any site that plays HTML5 `<video>` (YouTube, Netflix, Crunchyroll, Twitch, local files, embedded players…).
The page itself is not modified: the subtitles live in a shadow-DOM overlay that follows the video, including in fullscreen.

## Two engines

| Engine | Speech recognition | Translation | Cost | Privacy |
| --- | --- | --- | --- | --- |
| **Local** (default) | [MegaASR](https://xzf-thu.github.io/Mega-ASR/) on [mlx-audio](https://github.com/Blaizzy/mlx-audio) | A Qwen model in [Ollama](https://ollama.com) | Free, no API keys | Nothing leaves your Mac |
| **Cloud** | OpenAI Whisper | Claude, or an OpenAI model | Your API usage | Audio and text go to the providers |

The local engine needs an Apple Silicon Mac. MegaASR is Qwen3-ASR-1.7B with an extra layer that switches to a noise-robust
path when the audio is degraded, which helps with music and sound effects under dialogue. It understands Japanese,
Chinese, Korean, English and several European languages.

## Install

1. Chrome: open `chrome://extensions`. Brave: open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`Subtitles Extension`).
4. Pin the extension (puzzle-piece icon → pin) so the popup is one click away.

### Set up the local engine (once)

You need [Ollama](https://ollama.com/download) and [uv](https://docs.astral.sh/uv/) installed. Then run this in Terminal,
from this folder:

```bash
tools/setup-local.sh
```

It installs mlx-audio, registers the speech server as a login item on `http://127.0.0.1:8742`, and downloads two models:

| Model | Size | Used for |
| --- | --- | --- |
| `mlx-community/Mega-ASR-bf16` | about 4.2 GB | speech recognition |
| `qwen3:8b` | about 5.2 GB | translation |

The downloads resume where they stopped if they are interrupted. Check progress at any time:

```bash
tools/setup-local.sh status
```

When both models are downloaded, open the extension's **Settings** and press **Test speech server** and **Test Ollama**.
The first test loads each model into memory, which takes a few seconds.

Other choices, all set in Settings: `qwen3:14b` translates better but answers more slowly, and `qwen3:4b` is a smaller
download. `mlx-community/Qwen3-ASR-1.7B-8bit` is a lighter speech model. Download a different Ollama model with
`ollama pull <name>`, or a different speech model with `SPEECH_MODEL=<name> tools/setup-local.sh download`.

To remove the speech server login item: `tools/setup-local.sh uninstall`.

### Use the cloud engine instead

Open **Settings**, set **Run subtitles with** to **Cloud**, and paste your keys:

| Provider | Key looks like | Used for |
| --- | --- | --- |
| OpenAI | `sk-…` | Live speech recognition with Whisper (about $0.36 per hour of video) |
| Anthropic | `sk-ant-…` | Translating subtitle files and live transcripts with Claude |

## Using it

### Live subtitles

1. Open the video tab, click the extension icon, then **Start live subtitles**. The tab shows a capture indicator; you keep
   hearing the audio.
2. A red **Live** pill appears at the top-right of the video; it turns amber while a segment is being processed.
3. Subtitles appear a few seconds after the speech: the audio is cut at pauses into 1.5–7 second segments (adjustable in
   Settings). Each line is also placed on the video timeline, so seeking back shows it again.
4. **Stop** in the popup, or just close the tab.

### Subtitle file

1. Open the video, click the extension icon.
2. **Load .srt / .vtt / .ass** (or drop the file onto the popup). UTF-8, UTF-16 and Shift_JIS files are all handled.
3. Japanese lines show immediately and switch to English as each batch is translated. Use **Translate to English** to do it
   by hand.

### Timing and display

- **Delay** shifts the timing: add delay when subtitles show before the speech.
- **Size** and **Height** style the text.
- **Show the original text too** puts the Japanese line above the English one.

## How it works

- `content.js` runs in every frame, picks the main video (largest, preferably playing) and draws the active cues in a
  shadow-DOM overlay positioned over it each animation frame. It moves itself into the fullscreen element when needed.
- `popup.js` parses subtitle files locally (`lib/subtitles.js`) and hands the cues to `background.js`, which stores them per
  tab in session storage, forwards them to the page, and translates them in batches of 25 lines (`lib/providers.js`).
- Live mode: the popup asks for a tab-capture stream id; `background.js` opens an offscreen document (`offscreen.js`) that
  captures the tab audio, plays it back so you still hear it, mixes it down to 16 kHz mono (`pcm-worklet.js`,
  `lib/audio.js`), cuts it at pauses with an energy-based voice-activity detector and sends each segment for recognition.
  With the local engine every segment is transcribed by MegaASR and translated by Ollama with the previous lines as context.
- Ollama rejects requests from `chrome-extension://` origins unless `OLLAMA_ORIGINS` is configured. The extension instead
  drops the Origin header from its own requests to the Ollama address with a `declarativeNetRequest` rule, so a stock
  Ollama install works. Web pages are not affected by the rule.
- Common speech-model hallucinations on silence ("Thank you for watching", subtitle credits, repeated syllables) are filtered.

## Privacy

- Local engine: audio and text stay on your Mac. The speech server and Ollama listen only on `127.0.0.1`.
- Cloud engine: short WAV segments go to the speech API and subtitle text goes to the translation provider. Keys are stored
  in `chrome.storage.local` for this browser profile.
- The extension can only call `api.openai.com`, `api.anthropic.com` and `localhost` / `127.0.0.1` (see `manifest.json`).

## Limitations

- Live subtitles lag the speech by a few seconds: segment length plus recognition and translation time.
- The local engine keeps about 10 GB of models in memory while subtitles run, and the Mac works harder (fans, battery).
- Live mode captures one tab at a time; starting it on another tab moves it there.
- `tabCapture` only works for the tab the popup was opened on. If you see "Extension has not been invoked for the current
  page", click the icon while the video tab is active and press Start again.
- A player that fullscreens the bare `<video>` element (rather than a container) cannot show overlays.

## Development

- `npm test`: unit tests for the subtitle parser, the audio pipeline and both engines against a mock server.
- `node test/e2e.mjs`: loads the unpacked extension in Chromium through Playwright and checks the file → popup →
  background → overlay path, translation through the local engine, the Ollama origin rule against a running Ollama, delay,
  reload persistence, fullscreen and clear. Run `npm i -D playwright` first, or point `PLAYWRIGHT_DIR` at a project that
  has it. Live audio capture cannot be driven this way because `tabCapture` needs a real click on the extension icon.
- `node tools/make-icons.js` regenerates the icons.
- Test page without the extension: `python3 -m http.server 8791` in this folder, then open
  <http://localhost:8791/test/page.html>. `content.js` runs there as a plain script and the buttons drive the overlay.

```
manifest.json         MV3 manifest
background.js         service worker: message routing, per-tab state, file translation, Ollama origin rule
content.js            overlay renderer (all frames)
offscreen.html/js     tab-audio capture, segmenting, recognition and translation
pcm-worklet.js        AudioWorklet that mixes the capture down to mono chunks
popup.html/js         file loading, live start/stop, timing & display controls
options.html/js       engine choice, local servers, API keys, languages, segmenting
lib/settings.js       defaults, storage helpers, engine checks
lib/subtitles.js      SRT / VTT / ASS parsing, encoding detection
lib/audio.js          resampler, WAV encoder, voice-activity segmenter
lib/providers.js      MegaASR / Ollama (local) and Whisper / Claude / OpenAI (cloud), hallucination filter
tools/setup-local.sh  installs and checks the local engine
test/                 unit tests, e2e test, mock engines and the standalone test page
```
