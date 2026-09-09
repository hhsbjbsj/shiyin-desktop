# 拾音 (shiyin) — Local Audio/Video/Link to Text

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](RELEASE.md)
[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](package.json)
[![CI](https://github.com/x1303145921/shiyin/actions/workflows/ci.yml/badge.svg)](https://github.com/x1303145921/shiyin/actions/workflows/ci.yml)

> Speak, and it becomes text — an offline speech-to-text tool that keeps your files on your machine.

**拾音 (shiyin)** is a fully local, offline audio/video/link-to-text tool powered by [whisper.cpp](https://github.com/ggerganov/whisper.cpp)(https://github.com/ggerganov/whisper.cpp). Your audio files **never leave your computer** — everything runs on-device, ideal for meeting recordings, lecture notes, and interviews where privacy matters.

- **100% local**: server listens on `127.0.0.1` only; files and models never leave your machine
- **Paste a link**: drop a Bilibili/YouTube/Douyin/Kuaishou URL and get text — official subtitles are fetched in ~1s when available
- **Web UI**: double-click to launch, use in browser; needs Node.js 18+
- **Three outputs**: txt / srt / vtt — switch and edit inline, saved instantly
- **Subtitle follow-along**: built-in player + clickable subtitle lines with precise seeking
- **Free model choice**: fast / balanced / high-accuracy models, one-click download & switch

## ✨ Features

| Feature | Description |
|---|---|
| 🎙 **whisper.cpp on-device ASR** | Audio/video → text, fully offline, files never uploaded |
| 📝 **Three formats** | Plain txt / SRT / VTT subtitles, inline editing with instant save |
| 📖 **Follow-along mode** | Built-in player + subtitle list; click any line to seek (<0.3s error), auto-highlight, space to play/pause; audio & video |
| 🧹 **VAD silence skip** | Optional Silero VAD skips silent segments — faster long recordings, fewer hallucinations |
| 🧠 **Repetition fix** | Two-stage post-processing merges adjacent duplicates and collapses repeated words (verified: 40 repeats → 1) |
| ⏱ **Transcode skip** | 16kHz mono WAV files go straight to recognition (probe in milliseconds) |
| 🖱 **Global drag & drop** | Drop files anywhere on the page; live progress bar + client/server format validation |
| ↻ **One-click retry** | Failed tasks retry with the original media kept — no re-upload |
| 🎚 **Model manager** | base / small / turbo tiers, one-click download, switch & delete (hf-mirror.com) |
| 🔔 **Background notification** | Tab title flashes when transcription finishes while page is in background |
| 🔗 **Link distillation** | Paste a video link → transcription: Bilibili official API / YouTube subtitles-first / Douyin & Kuaishou adapters, auto-saved to inbox |
| 🎬 **Instant subtitles** | Bilibili/YouTube videos with official/AI subtitles output text in ~1s with zero compute |
| 🗂 **4-file archive** | Results auto-archived as `txt/srt/vtt/meta.json` in a same-name subfolder; output dir configurable |
| 🔤 **Hotwords** | Fix proper-noun misrecognition (e.g. Crawl4AI→CrossAI) via an API/settings word list |
| 🤖 **AI summary** | Optional OpenAI-compatible endpoint: summary/key points/sectioned (off by default, content leaves machine only if you enable it) |
| 📦 **PWA installable** | Install to desktop/taskbar, runs in standalone window |

## 🖼 Preview

![shiyin UI preview](assets/screenshot.png)

## ⬇️ Download

| Option | For whom | How |
|---|---|---|
| **git clone** | Everyone | `git clone https://github.com/x1303145921/shiyin.git` |
| **Source ZIP** | Just browsing | Green `Code` button → `Download ZIP` |
| **Releases** | Version tracking | [Releases page](https://github.com/x1303145921/shiyin/releases) |

> 💡 Requires Node.js 18+ ([download](https://nodejs.org/en/download)). Whisper models are 141–547 MB; download one from the Model Manager on first use.

## 🚀 Quick Start (Windows)

1. Install [Node.js 18+](https://nodejs.org/en/download)
2. Double-click `启动拾音.bat` — the service starts and the browser opens `http://127.0.0.1:18900`
3. Download a model in the Model Manager (recommended: **turbo**)
4. **Local file**: drag an audio/video file in, pick model & VAD, hit Start
   **Video link**: paste a Bilibili/YouTube/Douyin/Kuaishou URL — official subtitles are used instantly when available onto the page, click **开始识别**

### macOS / Linux

```bash
npm install
npm start    # → http://127.0.0.1:18900
```

## 🎙 Models

| Model | Size | Notes |
|---|---|---|
| `ggml-base.bin` | 141 MB | Fast · low-end hardware |
| `ggml-small.bin` | 465 MB | Balanced · daily use |
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | High accuracy · best value (recommended) |

Models are downloaded from hf-mirror.com with SHA256 verification into `D:\shiyin-cache\models`.

## 🔌 API Reference

Server listens on `127.0.0.1:18900`:

| Method | Path | Description |
|---|---|---|
| POST | `/api/transcribe` | Upload media and create a transcription task (multipart field `file`) |
| GET | `/api/tasks` | Task list (metadata only; large subtitle fields fetched on demand) |
| GET | `/api/task/:id` | Task detail (txt / srt / vtt + media info) |
| POST | `/api/task/:id/retry` | Retry a failed task (keeps original media) |
| GET | `/api/models` | Model list & download/active status |
| POST | `/api/models/use` | Switch active model (`{ "name": "..." }`) |
| POST | `/api/models/download` | Download model (`{ "name": "..." }`) |
| POST | `/api/vad/download` | Download Silero VAD model |

## 🛠 Development

```bash
node --check server.js
node --check scripts/render-icon.js
node --check scripts/build-ico.js
npm start
```

## 📁 Project Structure

```text
shiyin/
├── server.js               # Express server (upload/tasks/models/transcribe queue)
├── public/                 # Frontend (vanilla HTML/CSS/JS + PWA)
│   ├── index.html          # Main page (drag-drop/task cards/model panel/follow-along player)
│   ├── service-worker.js   # PWA cache (shiyin-v4)
│   ├── manifest.json       # PWA manifest
│   └── icon-source.webp   # Icon source file (mic icon)
├── scripts/                # render-icon.js (CDP transparent render) / build-ico.js (ICO packer)
├── assets/                 # Screenshots & visuals
├── 启动拾音.bat / 停止拾音.bat / 安装到桌面.bat
└── package.json / LICENSE / CHANGELOG.md / README.md / ...
```

## ❓ FAQ

| Question | Answer |
|---|---|
| Page won't open? | Install Node.js 18+; run `启动拾音.bat`; visit `http://127.0.0.1:18900` |
| Transcription slow? | Local CPU runs ~2–4× realtime (20–30s for 60s audio) — normal; try small model or VAD |
| Browser shows old icon? | Hard refresh (Ctrl+F5); re-pin/unpin PWA; re-run `安装到桌面.bat` |
| Supported formats? | Common audio/video (wav/mp3/m4a/flac/mp4/mkv/avi…); 16kHz mono WAV skips transcoding |
| Does it go online? | Only to download models (hf-mirror.com); transcription is fully offline |

## 🔒 Privacy & Security

- Listens on `127.0.0.1` only — never expose to LAN/public
- Uploads & intermediates are cleaned up after the task lifecycle ends
- No third-party CDN, no external script injection surface
- See [SECURITY.md](SECURITY.md) for the full security model

## 📜 License

[MIT License](LICENSE) © 2026 颜 (x1303145921)

---

*shiyin — gather sound by lamplight, let it become words on paper.*
