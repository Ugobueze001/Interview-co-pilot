
<div align="center">

# 🤖 AI Interview Assistant

A stealthy, real-time AI interview co-pilot built with **Electron + React + Vite**.

</div>

---

## ✨ Features

- **🥷 Absolute Stealth Mode**
  - Maps to OS-level capture exclusion (`WDA_EXCLUDEFROMCAPTURE` on Windows, `kCGWindowSharingNone` on macOS).
  - Invisible to Zoom, Google Meet, Teams, OBS, and any standard screen recorder.
  - Hidden from the taskbar/dock (`setSkipTaskbar`).
  - Runs as an always-on-top overlay.
- **🎙️ Dual Audio Listener**
  - Captures system audio (interviewer) via `getDisplayMedia` + microphone (you) via `getUserMedia`.
  - Gated by Silero VAD (Voice Activity Detection).
  - 600ms of interviewer silence instantly triggers the answer generation pipeline.
- **🎧 Local Whisper.cpp STT**
  - Uses a quantized tiny model for fully offline, secure transcription.
- **⚡ OpenRouter SSE Streaming**
  - Answers stream token-by-token for zero-latency reading.
  - Strictly formatted in a proven structure: *1. Define First ➔ 2. Why it matters ➔ 3. Example*.
- **📂 Local RAG (Retrieval-Augmented Generation)**
  - Your resume + job description are chunked and ranked via TF-IDF cosine similarity.
  - Top passages are injected into the context of every prompt.
- **⌨️ Manual Fallback**
  - Type any question and press `Enter` if audio capture fails.
- **🖱️ Click-Through Toggle**
  - `Ctrl/Cmd+Shift+X` toggles mouse pass-through so you can interact with the interview software underneath the overlay.

---

## 🚀 Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### OpenRouter API Key Configuration

Uses **100% free models** (`minimax/minimax-m2.7:free` → `google/gemma-4-31b-it:free` → `nvidia/nemotron-3-super-120b-a12b:free`) — no credits required.

Choose one of the following methods to provide your API key:

**Option 1: Local File (Recommended)**
Place your key in a gitignored file at the project root:
```text
openrouter.key        # File contents: sk-or-v1-...
```

**Option 2: Environment Variable**
Set the `OPENROUTER_API_KEY` environment variable in your terminal.

**Multi-Key Rate-Limit Fallback**
Provide keys in *both* places (or enter one in the onboarding form) and the app
uses them all: if one account hits its free-tier rate limit (HTTP 429), is
invalid, or has no credits, the next key takes over automatically — mid-answer
streaming is never duplicated. Priority order:
1. Key typed in the onboarding form
2. `OPENROUTER_API_KEY` from `.env`
3. `openrouter.key` file

### Local Whisper.cpp (Optional — enables voice transcription)

1. Download and build [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
2. Place the binaries in the app data directory:
   - `whisper-cli.exe` ➔ `%APPDATA%/aiinterviewassistant/whisper/whisper-cli.exe`
   - `ggml-tiny.bin` (or base) ➔ `%APPDATA%/aiinterviewassistant/whisper/models/ggml-tiny.bin`
3. *Alternatively*, you can point to custom paths by setting the `WHISPER_BIN` and `WHISPER_MODEL` environment variables.

> **Note:** Without Whisper installed, the app still works perfectly using the manual text input feature.

---

## 💻 Usage

1. Fill out the onboarding form (Name, Resume, Job Description, Skills, API Key).
2. Press **Start Listening** and share your screen/tab (ensure **"Share audio"** is checked).
3. When the interviewer stops talking (600ms of silence), the AI answer will instantly stream to your screen.
4. Press `Ctrl/Cmd+Shift+X` to toggle click-through if you need to interact with windows underneath the overlay.

---

## 🛠️ Scripts

| Command | Description |
| :--- | :--- |
| `npm run dev` | Start dev mode (Vite hot reload) |
| `npm run build` | Build for production |
| `npm run typecheck` | Run TypeScript type checks |

---

> ⚠️ **Windows VS Code Terminal Note:**
> If launching from a VS Code terminal, you must clear the node environment variable first, or Electron will fail to launch:
> ```powershell
> $env:ELECTRON_RUN_AS_NODE=''
> npm run dev
> ```
```
