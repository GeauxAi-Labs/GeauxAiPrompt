# Changelog

All notable changes to **GeauxAiPrompt** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [3.0.0] — 2026-03-14

### Summary
Major release adding full TTS audio readback via two engines (ElevenLabs cloud and Kokoro local),
SSE real-time push replacing meta-refresh, Tavily web search, glassmorphic UI redesign,
multi-user support, auto-restart wrapper, and a suite of audio playback bug fixes.
The app is now a complete voice AI assistant — it speaks responses back to you, not just
displays them on the glasses.

---

### Added

#### 🎙️ ElevenLabs TTS
- AI responses read aloud via `session.audio.speak()` routing through MentraOS's proxy
- Voice ID configurable via `ELEVENLABS_VOICE_ID` env var
- Uses `eleven_flash_v2_5` model for low latency
- Free — Mentra absorbs ElevenLabs cost through their proxy (confirmed: zero charges to user account)

#### 🔊 Kokoro Local TTS
- Local Docker-based TTS via `ghcr.io/remsky/kokoro-fastapi-cpu:latest` on port 8880
- OpenAI-compatible API (`/v1/audio/speech`)
- 67 voice packs — American, British, Japanese, Chinese, Portuguese, Korean voices
- `KOKORO_HOST` and `KOKORO_VOICE` env vars
- MP3 audio cached in memory with 300-second TTL
- Audio delivered to browser via SSE `tts_audio` event → `<audio>` element
- Fully offline, unlimited, free

#### ⚡ TTS Engine Toggle
- Runtime switching between ElevenLabs and Kokoro via chip button in web UI
- Per-user engine state persisted in UserState

#### 📡 SSE Real-Time Push (replaced meta-refresh)
- `/api/stream` endpoint with `Content-Type: text/event-stream`
- Named events: `state`, `device`, `listening`, `tts_audio`, `keepalive`
- Per-user `sseClients` array in UserState
- `broadcastToUser()` utility function
- Client-side EventSource with 120-second watchdog timer
- Server sends named `keepalive` event every 10 seconds to reset watchdog
- Eliminated auth.middleware log flood (was ~4 hits/second per user with meta-refresh)

#### 🔍 Tavily Web Search
- `detectSearchIntent()` automatically triggers web search for time-sensitive queries
- Covers: news, sports scores, weather, current events, dates
- `TAVILY_API_KEY` env var
- Search context injected into AI prompt

#### 🎨 Glassmorphic Web UI Redesign
- Dark theme with Syne + JetBrains Mono fonts
- Animated waveform visualizer
- AJAX prompt submission (no page reload on send)
- Prompt counter
- TTS engine and voice toggle chips in header
- Status chips: LIVE, VOICE ON/OFF, KOKORO/ELEVEN, MIC ON/OFF

#### 🔄 Auto-Restart Wrapper (`start.sh`)
- Bash wrapper restarts `bun run src/index.ts` on crash
- Max 10 restarts with 3-second delay between attempts
- `start-dev.sh` hot-reload variant for development using `bun --watch`

#### 👥 Multi-User Support
- `userStates` Map isolates state per userId
- Separate conversation history, TTS settings, SSE clients, timers per user

#### 📱 Android APK
- WebView wrapper pointing to `app.geauxailabs.com`
- `setDomStorageEnabled(true)` required for Cloudflare auth persistence

#### 🔒 Cloudflare Zero Trust Access
- Email OTP authentication on `app.geauxailabs.com`

#### 🏷️ Dashboard Status Indicators
All key lifecycle events write to the glasses dashboard bar:
- Connect: `🎤 GeauxAI · {model}`
- Processing: `⏳ Thinking...`
- Searching: `🔍 Searching web...`
- Complete: `✓ GeauxAI · {model}`

---

### Bug Fixes

#### 🐛 BUG-004 — Kokoro audio URL resolving to wrong host (503 errors)
**Symptom:** Kokoro audio returned HTTP 503 when fetched from localhost browser.  
**Root cause:** `speakWithKokoro()` built the audio URL using `PUBLIC_BASE_URL` (the Cloudflare tunnel domain). Browser on localhost tried to fetch from the remote URL, got 503.  
**Fix:** Changed audio URL to relative path `/tts-audio/${id}`. Resolves correctly against whatever origin the browser is on (localhost or Cloudflare).

#### 🐛 BUG-005 — Chrome double-fetches audio URL, one-shot cache delete killed second request
**Symptom:** Audio element loaded but played no sound. Network showed 200 then 404 for the same URL.  
**Root cause:** Chrome's `<audio>` element makes two HTTP requests per src — a metadata probe then the full stream. Original code had `audioCache.delete(req.params.id)` (one-shot delete). First request deleted the entry; second got 404.  
**Fix:** Removed `audioCache.delete()`. Cache expires via 300-second TTL.

#### 🐛 BUG-006 — AutoClear timer firing before Kokoro audio arrived
**Symptom:** Display cleared and audio cut off mid-sentence.  
**Root cause:** 15-second AutoClear started at AI text completion. Kokoro generation takes additional time. Timer expired before audio reached the browser.  
**Fix 1:** `showOnGlasses()` now returns early (skips starting AutoClear) when `ttsEngine === 'kokoro'`.  
**Fix 2:** `speakWithKokoro()` starts AutoClear only after broadcasting the audio URL to the browser.  
**Fix 3:** `AUTO_CLEAR_DELAY_MS` default increased from 15000 → 60000ms.

#### 🐛 BUG-007 — SSE watchdog reloading page mid-audio (root cause of all cutoffs)
**Symptom:** Audio cut off randomly mid-sentence, page reloaded, `_kplayer` element disappeared from DOM.  
**Root cause:** Server was sending SSE keepalives as comments (`: keepalive\n\n`). **SSE comments are invisible to JavaScript** — the client's EventSource never fires an event for them. The client `sseTimer` watchdog (120 seconds) only reset on `state` events. During Kokoro generation (no state events for several seconds), `safeReload()` eventually fired and called `window.location.reload()`, killing the page and audio mid-playback.  
**Fix:** Changed server keepalive from a comment to a named SSE event (`event: keepalive\ndata: {}\n\n`) sent every 10 seconds. Added client `keepalive` event listener that resets `sseTimer`. During generation, multiple keepalives fire and the watchdog never expires.

#### 🐛 BUG-008 — Audio cache TTL too short for long responses
**Symptom:** Long responses cut off near the end of playback.  
**Root cause:** 60-second cache TTL. Long responses: generate time + playback time could approach or exceed 60 seconds.  
**Fix:** TTL increased from 60_000 → 300_000ms (5 minutes).

#### 🐛 BUG-009 — Old audio replaying when new prompt submitted
**Symptom:** Sending a second prompt replayed the previous response until the new one arrived.  
**Root cause:** `doSend()` unlock IIFE called `p.play()` on `_kplayer` which still had the previous audio's `src` set.  
**Fix:** Added `p.pause(); p.src='';` before the unlock play call in `doSend()`.

#### 🐛 BUG-010 — `/tts-audio/:id` missing HTTP Range request support
**Symptom:** Audio element stalled or stopped mid-playback on some responses.  
**Root cause:** Chrome's audio element sends HTTP Range requests (`Range: bytes=N-`). Route returned plain 200 without `Accept-Ranges` header.  
**Fix:** Added proper 206 Partial Content response with `Content-Range` and `Accept-Ranges: bytes` headers.

---

### Changed

- `AUTO_CLEAR_DELAY_MS` default: 15000 → 60000
- audioCache TTL: 60_000 → 300_000ms
- SSE keepalive: comment every 25s → named event every 10s
- SSE watchdog: was reset only on `state` events → now also resets on `keepalive` events
- AI model default: `llama3.2:3b` → `deepseek-v3.1:671b-cloud`
- WebView: meta-refresh every 4s → SSE real-time push

---

## [2.0.0-beta] — 2026-03-01

### Summary
Graduates GeauxAiPrompt from alpha to beta. Core voice + typed-prompt pipeline is stable
end-to-end. Three critical race condition bugs fixed.

### Bug Fixes

#### 🐛 BUG-001 — Typed prompts did not refresh webview when mic muted
**Root cause:** Race condition in `pendingRefresh` one-shot flag. `POST /prompt` set flag and fired AI async, then redirected to `GET /webview`. First GET consumed the flag → served `content="3600"` before AI finished.  
**Fix:** `refreshSecs` now uses `isProcessing || pendingRefresh` as compound guard. Fast-refresh stays alive for entire AI inference window.

#### 🐛 BUG-002 — Webview showed "Thinking..." for minutes after AI responded
**Root cause:** `isProcessing` held `true` through entire `showOnGlasses` loop (5s sleep × N pages = 20-30s after AI done).  
**Fix:** `isProcessing = false` released immediately after AI responds and history updated, before `showOnGlasses` begins. Glasses paging runs in background without blocking web UI.

#### 🐛 BUG-003 — Textarea blur restored wrong meta-refresh rate
**Root cause:** Hardcoded `liveInterval = '4'` in page JS. Blur always reset to 4s even when server intended 3600s.  
**Fix:** `idleInterval` baked into HTML at render time by server. Blur restores server-intended rate.

### Added
- `isProcessing`-aware refresh logic
- Early processing lock release
- Server-baked `idleInterval` in page JS
- `device_state_update` SDK error suppression
- `AI_MODEL` default corrected to `llama3.2:3b`

---

## [1.0.0-alpha] — 2026-02-01

- Initial MentraOS app scaffolding with `@mentra/sdk`
- Ollama / llama3.2:3b integration
- Voice transcription → AI → glasses TextWall pipeline
- Meta-refresh webview chat log
- Mic toggle, New Chat, button-press page navigation
- Multi-provider support (Ollama / Anthropic / OpenAI)
- Package: `com.geauxailabs.geauxaiprompt`
