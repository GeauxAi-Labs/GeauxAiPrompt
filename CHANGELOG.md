# Changelog

All notable changes to **GeauxAiPrompt** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [2.0.0-beta] — 2026-03-01

### Summary
This release graduates GeauxAiPrompt from alpha to beta. The core voice + typed-prompt
pipeline is now stable end-to-end on the Even Realities G1 / MentraOS platform.
Three critical bugs were diagnosed and fixed: two race conditions in the webview refresh
state machine and one in the processing lock lifecycle.

---

### Bug Fixes

#### 🐛 BUG-001 — Typed prompts did not refresh the webview when mic was muted
**Symptom:** Submitting a typed prompt with the mic toggled OFF caused the page to freeze.
The AI response never appeared in the browser window. The page would briefly show
"Thinking..." for one 4-second cycle then lock up for ~1 hour.

**Root cause:** A race condition in the `pendingRefresh` one-shot flag.  
`POST /prompt` set `pendingRefresh = true` and fired the AI call asynchronously, then
immediately redirected the browser to `GET /webview`. That first `GET` consumed the flag
(`pendingRefresh → false`) and served `content="4"`. Four seconds later the next `GET`
saw `pendingRefresh = false` AND `micMuted = true` → served `content="3600"`. But Ollama
hadn't finished yet (typical inference time: 5–15 seconds). The response landed in state
after the page had already frozen at the 1-hour refresh interval.

**Fix:** Changed the `refreshSecs` decision from a one-shot flag to tracking the full
processing window. The page now serves `content="4"` for as long as `isProcessing = true`
OR `pendingRefresh = true`, keeping fast-refresh alive for the entire duration of AI
inference regardless of mic state. `pendingRefresh` is cleared in the `finally` block of
`handlePrompt` so the page correctly returns to `content="3600"` (idle+muted) only after
the response has been stored to `state.history`.

```
Before:  muted + prompt → 4s refresh → 3600s (frozen, AI still running)
After:   muted + prompt → 4s refresh → 4s refresh → ... → AI done → 3600s (idle)
```

---

#### 🐛 BUG-002 — Webview showed "Thinking..." for minutes after AI had already responded
**Symptom:** After a typed prompt completed successfully, the browser kept refreshing
every 4 seconds and displaying the "Thinking..." status pill for an extended period
(sometimes 20–30+ seconds) before finally settling. Observed clearly in ngrok request
logs as a long run of `GET /webview 200 OK` every ~4 seconds post-response.

**Root cause:** `isProcessing` was held `true` for the entire duration of `showOnGlasses`,
not just the AI call. `showOnGlasses` loops through paginated glasses display pages with
`await sleep(PAGE_DELAY)` (5 seconds) between each page. For a multi-paragraph response
this could mean 4–6 pages × 5 seconds = 20–30 seconds of `isProcessing = true` after
the AI had already responded. Since `isProcessing = false` only ran in the `finally`
block (which fires after `showOnGlasses` fully resolves), the webview was locked in the
"Thinking..." fast-refresh state the entire time.

**Fix:** `isProcessing` and `pendingRefresh` are now cleared immediately after `callAI`
returns and `state.history` is updated — before `showOnGlasses` is called. The response
is already in state at that point so the webview renders it correctly on the next 4-second
refresh. `showOnGlasses` continues to page through the glasses display in the background
without blocking the web UI state.

```
Before:  AI done → showOnGlasses (sleeps 5s × N pages) → finally → isProcessing=false
After:   AI done → isProcessing=false → showOnGlasses runs in background (non-blocking)
```

---

#### 🐛 BUG-003 — Page JavaScript restored wrong refresh rate after textarea blur
**Symptom:** When mic was muted and idle (`content="3600"`), focusing and then blurring
the textarea input would snap the meta-refresh back to `content="4"` (fast poll), causing
unnecessary constant page reloads even when no prompt was being processed.

**Root cause:** The inline JavaScript that pauses the meta-refresh on textarea focus used
a hardcoded `liveInterval = '4'` as the "resume" value. This was correct when the mic
was live, but incorrect when the server had intentionally served `content="3600"` for an
idle muted session. Blurring the textarea always reset the rate to 4 seconds regardless
of the actual server-intended interval.

**Fix:** `idleInterval` is now baked into the HTML at render time by the server using the
template literal `'${refreshSecs}'`. When the textarea is blurred, JavaScript restores
the server-intended rate — `"4"` if the mic is live or AI is processing, `"3600"` if mic
is muted and idle.

---

### Added

- **`isProcessing`-aware refresh logic** — the `refreshSecs` decision now uses
  `isProcessing || pendingRefresh` as a compound guard so the webview stays in fast-poll
  mode for the entire AI processing window, not just a single 4-second cycle.

- **Early processing lock release** — `handlePrompt` releases `isProcessing = false`
  immediately after AI responds and history is updated, before the glasses paging loop
  begins. Web UI and glasses display are now decoupled.

- **Server-baked `idleInterval` in page JS** — the meta-refresh JavaScript now receives
  its idle rate from the server at render time instead of using a hardcoded value. The
  correct rate is always restored after textarea blur.

- **`device_state_update` error suppression** — the G1 firmware sends `device_state_update`
  WebSocket messages that the current `@mentra/sdk` version does not yet handle. Rather
  than flooding the console with ERROR/WARN pairs on every message, the session
  `emit` handler is monkey-patched in `onSession` to silently drop these known-harmless
  events. Everything functions correctly; this is purely cosmetic log hygiene.

- **Corrected `AI_MODEL` default** — default changed from `'llama3.2'` to `'llama3.2:3b'`
  to match the actual Ollama model tag. Prevents a model-not-found error on first launch
  with no `.env` override set.

---

### Unchanged / Stable Features (carried from v1.0.0-alpha)

- Voice transcription via G1 onboard microphone (always-on, en-US)
- Typed prompt input from the webview footer textarea
- Mic mute / unmute toggle (persists across refreshes)
- New Chat button (clears history server-side and on glasses)
- Multi-page response pagination on glasses display (38 chars/line × 5 lines/page)
- Left/right TouchBar navigation for paging through multi-page responses
- Long-press either TouchBar to clear history
- Session expired page (prevents 401 log flood after ~3 hour token timeout)
- AI provider switching: Ollama (default), Anthropic, OpenAI via env vars
- Zero-JavaScript webview rendering (meta-refresh only, works in any WebView)
- Cache-Control: no-store on all webview responses

---

### Known Issues

- `device_state_update` messages from G1 firmware are suppressed but not handled.
  Proper handling is pending `@mentra/sdk` upstream support.
- Transcription events from the glasses mic still fire while mic is marked "muted"
  in app state — the `onTranscription` handler guards against acting on them, but
  the stream itself is not paused at the SDK level.

---

## [1.0.0-alpha] — 2026-02-01 *(initial release)*

- Initial MentraOS app scaffolding with `@mentra/sdk`
- Ollama / llama3.2:3b integration via local HTTP API
- Voice transcription → AI response → glasses TextWall display pipeline
- Meta-refresh webview chat log (zero JavaScript)
- Mic toggle, New Chat button, button-press page navigation
- Multi-provider support (Ollama / Anthropic / OpenAI) via environment variables
- Package: `com.geauxailabs.geauxaiprompt`
