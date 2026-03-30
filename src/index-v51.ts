import { AppServer, AppSession } from '@mentra/sdk';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '3000');
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.geauxailabs.geauxaiprompt';
const API_KEY      = process.env.MENTRA_API_KEY || '';
const AI_PROVIDER  = process.env.AI_PROVIDER   || 'ollama';
const AI_MODEL     = process.env.AI_MODEL      || 'deepseek-v3.1:671b-cloud';
const WAKE_WORD    = (process.env.WAKE_WORD    || 'Go AI').toLowerCase();
const OPENAI_KEY   = process.env.OPENAI_API_KEY   || '';
const ANTHROPIC_KEY= process.env.ANTHROPIC_API_KEY|| '';
const OLLAMA_HOST  = process.env.OLLAMA_HOST   || 'http://localhost:11434';
const PAGE_DELAY         = parseInt(process.env.PAGE_DELAY_MS        || '4000');
const AUTO_CLEAR_DELAY_MS  = parseInt(process.env.AUTO_CLEAR_DELAY_MS  || '15000');
const STATUS_CLEAR_DELAY_MS = parseInt(process.env.STATUS_CLEAR_DELAY_MS || '5000');
const OWNER_EMAIL  = process.env.OWNER_EMAIL || '';
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== 'false';
const TAVILY_API_KEY     = process.env.TAVILY_API_KEY     || '';
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const KOKORO_HOST   = process.env.KOKORO_HOST   || 'http://localhost:8880';
const KOKORO_VOICE  = process.env.KOKORO_VOICE  || '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN  = process.env.CF_API_TOKEN  || '';
const MAX_HISTORY_PAIRS  = 10;   // keep last 10 user+assistant pairs (20 messages)
const MAX_RESPONSE_CHARS = 8000; // cap runaway model output before display
const MAX_DISPLAY_CHARS  = 8000; // pagination handles length — no artificial cut
const RATE_LIMIT_WINDOW_MS   = 60000;  // 60-second rolling window
const RATE_LIMIT_MAX_REQUESTS = 10;    // max prompts per window

// ── State ─────────────────────────────────────────────────────────────────────
interface GenParams {
  systemPrompt: string;
  temperature:  number;
  topP:         number;
  maxTokens:    number;
  model:        string;  // empty string = use AI_MODEL from .env (server default)
  webSearch:    boolean;
  useCloudflare: boolean;
  elevenLabsVoiceId: string;
  elevenDirectVoiceId:  string;
  elevenPathPref:    'mentraos' | 'geauxai';
  kokoroVoice: string;
  avatarEnabled:     boolean;
  browserMicEnabled: boolean;
}

interface UserState {
  history:        { role: string; content: string }[];
  lastResponse:   string;
  isProcessing:   boolean;
  micMuted:       boolean;
  pendingRefresh: boolean;  // true after typed prompt — serve one 4s refresh then reset
  // Pagination state — stored so buttons can navigate without re-running AI
  pages:          string[];  // paginated chunks of lastResponse
  pageIndex:      number;    // currently displayed page (0-based)
  autoClearTimer:  ReturnType<typeof setTimeout> | null;  // per-user AI response auto-clear
  statusClearTimer: ReturnType<typeof setTimeout> | null;  // per-user status message auto-clear
  genParams:      GenParams;  // per-user AI generation parameters
  sseClients:     any[];      // SSE response objects waiting for push events
  deviceState:    { batteryLevel: number | null; charging: boolean; wifiConnected: boolean; } | null;
  isListening:    boolean;
  ttsEnabled:     boolean;
  ttsEngine:      'elevenlabs' | 'elevenlabs_direct' | 'kokoro';
  lastPrompt:     string;   // last user question shown on glasses (Q&A header)
}
const userStates          = new Map<string, UserState>();
const activeSessions      = new Map<string, AppSession>();
const devicePollIntervals = new Map<string, ReturnType<typeof setInterval>>();
const rateLimits          = new Map<string, { count: number; resetTime: number }>();
const audioCache          = new Map<string, { buf: Buffer; expires: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of audioCache) {
    if (now > entry.expires) audioCache.delete(id);
  }
}, 300_000);

const DEFAULT_GEN_PARAMS: GenParams = {
  systemPrompt: '',
  temperature:  0.7,
  topP:         0.95,
  maxTokens:    2048,
  model:        '',
  webSearch:    true,
  useCloudflare: false,
  elevenLabsVoiceId: '',
  elevenDirectVoiceId: '',
  elevenPathPref:    'mentraos' as 'mentraos' | 'geauxai',
  kokoroVoice: '',
  avatarEnabled:     true,
  browserMicEnabled: false,
};

DEFAULT_GEN_PARAMS.elevenLabsVoiceId = ELEVENLABS_VOICE_ID;
DEFAULT_GEN_PARAMS.elevenDirectVoiceId = '';
DEFAULT_GEN_PARAMS.elevenPathPref = 'mentraos';
DEFAULT_GEN_PARAMS.kokoroVoice = KOKORO_VOICE;

const CF_MODELS: string[] = [
  '@cf/nvidia/nemotron-3-120b-a12b',
'@cf/zai-org/glm-4.7-flash',
'@cf/ibm-granite/granite-4.0-h-micro',
'@cf/aisingapore/gemma-sea-lion-v4-27b-it',
'@cf/openai/gpt-oss-20b',
'@cf/qwen/qwen3-30b-a3b-fp8',
'@cf/meta/llama-4-scout-17b-16e-instruct',
'@cf/google/gemma-3-12b-it',
'@cf/mistralai/mistral-small-3.1-24b-instruct',
'@cf/qwen/qwq-32b',
'@cf/qwen/qwen2.5-coder-32b-instruct',
'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
'@cf/meta/llama-3.3-70b-instruct-fp8-fast',
'@cf/meta/llama-3.2-1b-instruct',
'@cf/meta/llama-3.2-3b-instruct',
'@cf/meta/llama-3.1-8b-instruct-awq',
'@cf/meta/llama-3.1-8b-instruct-fp8',
'@cf/meta/llama-3-8b-instruct-awq',
'@cf/meta/llama-3-8b-instruct',
'@hf/mistral/mistral-7b-instruct-v0.2',
'@cf/google/gemma-7b-it-lora',
'@cf/google/gemma-2b-it-lora',
'@cf/meta-llama/llama-2-7b-chat-hf-lora',
'@hf/google/gemma-7b-it',
'@hf/nousresearch/hermes-2-pro-mistral-7b',
'@cf/mistral/mistral-7b-instruct-v0.2-lora',
];

function getState(userId: string): UserState {
  if (!userStates.has(userId)) {
    userStates.set(userId, {
      history: [], lastResponse: '', isProcessing: false,
      micMuted: false, pendingRefresh: false,
      pages: [], pageIndex: 0, autoClearTimer: null, statusClearTimer: null,
      genParams: { ...DEFAULT_GEN_PARAMS }, sseClients: [], deviceState: null,
      isListening: false, ttsEnabled: false, ttsEngine: 'kokoro', lastPrompt: '',
    });
  }
  return userStates.get(userId)!;
}

function cancelAutoClearTimer(userId: string) {
  const s = getState(userId);
  if (s.autoClearTimer !== null) {
    clearTimeout(s.autoClearTimer);
    s.autoClearTimer = null;
    console.log(`[AutoClear] Timer cancelled for ${userId}`);
  }
}

function cancelStatusClearTimer(userId: string) {
  const s = getState(userId);
  if (s.statusClearTimer !== null) {
    clearTimeout(s.statusClearTimer);
    s.statusClearTimer = null;
    console.log(`[StatusClear] Timer cancelled for ${userId}`);
  }
}

function broadcastToUser(userId: string, event: string, data: object) {
  const s = userStates.get(userId);
  if (!s || s.sseClients.length === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  s.sseClients = s.sseClients.filter(res => {
    try { res.write(payload); return true; } catch { return false; }
  });
}

async function showStatusOnGlasses(session: AppSession, userId: string, msg: string) {
  cancelStatusClearTimer(userId);
  try { await session.layouts.showTextWall('GeauxAI\n' + msg); } catch {}
  const s = getState(userId);
  s.statusClearTimer = setTimeout(async () => {
    s.statusClearTimer = null;
    const activeSession = activeSessions.get(userId);
    if (activeSession) {
      try { await activeSession.layouts.clearView(); } catch {}
      console.log(`[StatusClear] Display cleared for ${userId}`);
    }
  }, STATUS_CLEAR_DELAY_MS);
  console.log(`[StatusClear] Timer started for ${userId} (${STATUS_CLEAR_DELAY_MS}ms)`);
}

function esc(t: string): string {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── Web UI ────────────────────────────────────────────────────────────────────
function buildPage(
  connected: boolean,
  processing: boolean,
  history: { role: string; content: string }[],
  micMuted: boolean,
  ttsEnabled: boolean,
  ttsEngine: 'elevenlabs' | 'elevenlabs_direct' | 'kokoro',
  promptCount: number = 0
): string {
  const ttsChipLabel = ttsEnabled ? '🔊 VOICE ON' : '🔇 VOICE OFF';
  const engineChipLabel = ttsEngine === 'kokoro' ? '⚡ KOKORO' : ttsEngine === 'elevenlabs_direct' ? '☁ ELEVEN (Direct)' : '☁ ELEVEN';
  const statusChipClass = processing ? 'chip-thinking' : connected ? 'chip-live' : 'chip-offline';
  const statusChipLabel = processing ? '● THINKING' : connected ? '● LIVE' : '● OFFLINE';
  const statusText = processing
    ? '⏳ Generating response...'
    : connected
      ? `🟢 Say &quot;${esc(WAKE_WORD)}&quot; then speak`
      : '⚪ Waiting for glasses connection...';
  const dotClass = processing ? 'busy' : connected ? 'ok' : '';

  let bubbles = '';
  if (history.length === 0) {
    bubbles = `<div class="empty">
      <div class="empty-orb">
        <svg viewBox="0 0 56 56" fill="none"><circle cx="28" cy="28" r="24" stroke="currentColor" stroke-width="1.5" stroke-dasharray="5 4" opacity=".4"/><circle cx="28" cy="28" r="14" stroke="currentColor" stroke-width="1" opacity=".25"/><circle cx="28" cy="28" r="4" fill="currentColor" opacity=".6"/></svg>
      </div>
      <div class="empty-title">GeauxAI is ready</div>
      <div class="empty-sub">Say <kbd>${esc(WAKE_WORD)}</kbd> then ask anything.<br>Your conversation streams here live.</div>
    </div>`;
  } else {
    for (const msg of history) {
      const u = msg.role === 'user';
      let displayContent = msg.content;
      let attachLabel = '';
      if (u) {
        if (msg.content.startsWith('[Image] ')) {
          attachLabel = '<span style="font-size:10px;color:var(--v3);font-family:var(--mono);margin-bottom:3px;display:block">📎 IMAGE</span>';
          displayContent = msg.content.slice(8);
        } else if (msg.content.startsWith('[Audio transcript]:')) {
          const lines = msg.content.split('\n\n');
          const userText = lines.slice(1).join('\n\n');
          const transcript = lines[0].replace('[Audio transcript]: ', '');
          attachLabel = '<span style="font-size:10px;color:var(--c2);font-family:var(--mono);margin-bottom:3px;display:block">🎤 AUDIO</span>';
          displayContent = (userText || transcript).slice(0, 200);
        } else if (msg.content.startsWith('[Document content]:')) {
          attachLabel = '<span style="font-size:10px;color:var(--g2);font-family:var(--mono);margin-bottom:3px;display:block">📄 DOC</span>';
          displayContent = msg.content.split('\n\n').slice(1).join('\n\n') || '[document]';
          displayContent = displayContent.slice(0, 200);
        }
      }
      bubbles += `<div class="msg ${u ? 'msg-u' : 'msg-a'}">
        <div class="msg-role">${u ? 'YOU' : 'AI'}</div>
        <div class="msg-body">${attachLabel}${esc(displayContent)}</div>
      </div>`;
    }
    if (processing) {
      bubbles += `<div class="msg msg-a" id="thinking">
        <div class="msg-role">AI</div>
        <div class="msg-body dots"><span></span><span></span><span></span></div>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>GeauxAI · G1</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#09071a;--bg2:#110e24;--bg3:#1a1630;
  --glass:#ffffff07;--glass2:#ffffff10;
  --edge:#ffffff14;--edge2:#ffffff22;
  --v:#7c3aed;--v2:#a855f7;--v3:#c4b5fd;
  --c:#06b6d4;--c2:#67e8f9;
  --g:#10b981;--g2:#34d399;
  --a:#f59e0b;--r:#ef4444;
  --tx:#f1f5f9;--tx2:#94a3b8;--tx3:#475569;
  --mono:'JetBrains Mono',monospace;
  --ui:'Syne',sans-serif;
  --rad:12px;
}
[data-theme="light"]{
  --bg:#f5f3ff;--bg2:#ede9fe;--bg3:#ffffff;
  --glass:#7c3aed0a;--glass2:#7c3aed14;
  --edge:#7c3aed1a;--edge2:#7c3aed28;
  --v:#7c3aed;--v2:#a855f7;--v3:#6d28d9;
  --c:#0891b2;--c2:#0e7490;
  --g:#059669;--g2:#047857;
  --a:#d97706;--r:#dc2626;
  --tx:#1e1b4b;--tx2:#4c1d95;--tx3:#7c3aed;
}
html{height:100%;-webkit-text-size-adjust:100%}
body{
  min-height:100%;background:var(--bg);color:var(--tx);font-family:var(--ui);
  background-image:
    radial-gradient(ellipse 70% 40% at 50% 0%,#2d0f5c1a 0%,transparent 65%),
    radial-gradient(ellipse 40% 25% at 85% 75%,#0a3d4a14 0%,transparent 55%);
  background-attachment:fixed;
}
[data-theme="light"] body{background-image:radial-gradient(ellipse 70% 40% at 50% 0%,#7c3aed12 0%,transparent 65%),radial-gradient(ellipse 40% 25% at 85% 75%,#0891b20e 0%,transparent 55%)}
.shell{display:flex;flex-direction:column;min-height:100dvh;max-width:540px;margin:0 auto}

/* Header */
.hd{
  position:sticky;top:0;z-index:20;
  padding:10px 14px 8px;
  background:linear-gradient(180deg,var(--bg) 75%,transparent);
  display:flex;align-items:center;gap:8px;
}
.hd-brand{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.logo-img{width:32px;height:32px;flex-shrink:0;border-radius:9px;object-fit:contain;}
.hd-text{min-width:0}
.hd-name{
  font-family:var(--mono);font-size:10px;font-weight:700;
  color:var(--v3);letter-spacing:.07em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.hd-sub{font-family:var(--mono);font-size:8px;color:var(--tx3);letter-spacing:.04em}
.hd-right{display:flex;gap:5px;align-items:center;flex-shrink:0}

/* Chips */
.chip{
  display:inline-flex;align-items:center;gap:3px;
  font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.07em;
  padding:4px 8px;border-radius:99px;border:1px solid;
  cursor:pointer;background:transparent;-webkit-appearance:none;
  transition:background .15s,transform .1s;white-space:nowrap;
}
.chip:active{transform:scale(.94)}
.chip-status{pointer-events:none;border-color:var(--edge);color:var(--tx3)}
.chip-live{border-color:#10b98140;color:var(--g);background:#10b9810a}
.chip-thinking{border-color:#f59e0b40;color:var(--a);background:#f59e0b0a;animation:blink 1.6s infinite}
.chip-offline{border-color:var(--edge);color:var(--tx3)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.6}}
.chip-mic{border-color:var(--g2);color:var(--g2)}
.chip-mic.muted{border-color:var(--r);color:var(--r)}
.chip-mic:active{background:var(--glass)}
.chip-tts{border-color:var(--c);color:var(--c)}
.chip-tts.off{border-color:var(--edge);color:var(--tx3)}
.chip-engine{border-color:var(--v2);color:var(--v3)}
.chip-x{border-color:var(--edge);color:var(--tx3)}
.chip-x:active{background:var(--glass);border-color:#ef444460;color:var(--r)}
.chip-theme{border-color:var(--edge);color:var(--tx2);font-size:12px;padding:3px 7px}

/* Status bar */
.sbar{
  display:flex;align-items:center;gap:8px;padding:5px 14px;
  background:var(--glass);border-bottom:1px solid var(--edge);flex-shrink:0;
  font-family:var(--mono);font-size:10px;color:var(--tx3);
}
.sdot{width:5px;height:5px;border-radius:50%;background:var(--tx3);flex-shrink:0}
.sdot.ok{background:var(--g);box-shadow:0 0 6px var(--g)}
.sdot.busy{background:var(--a);box-shadow:0 0 6px var(--a)}
.stxt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scount{font-size:8px;color:var(--tx3);flex-shrink:0}

/* Listening bar */
.lbar{
  display:none;padding:8px 14px;
  background:linear-gradient(90deg,transparent,var(--bg2) 15%,var(--bg2) 85%,transparent);
  border-bottom:1px solid #7c3aed28;
  font-family:var(--mono);font-size:11px;color:var(--v3);
  align-items:flex-start;gap:8px;
  max-height:140px;overflow-y:auto;
}
.lwave{display:flex;gap:2px;align-items:center;flex-shrink:0}
.lwave span{
  display:block;width:2px;background:var(--v2);border-radius:1px;
  animation:wave .8s ease-in-out infinite;
}
.lwave span:nth-child(1){height:5px;animation-delay:0s}
.lwave span:nth-child(2){height:11px;animation-delay:.1s}
.lwave span:nth-child(3){height:7px;animation-delay:.2s}
.lwave span:nth-child(4){height:13px;animation-delay:.15s}
.lwave span:nth-child(5){height:5px;animation-delay:.05s}
@keyframes wave{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.35)}}
.ltxt{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.55;}

/* Params */
.params-wrap{border-bottom:1px solid var(--edge);flex-shrink:0}
.params-btn{
  width:100%;padding:7px 14px;display:flex;align-items:center;justify-content:space-between;
  background:transparent;border:none;cursor:pointer;
  font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
  color:var(--tx3);transition:color .15s;
}
.params-btn:hover{color:var(--v3)}
.params-chev{transition:transform .2s}
.params-body{padding:10px 14px 14px;background:var(--glass);display:flex;flex-direction:column;gap:11px}
.p-row{display:flex;flex-direction:column;gap:4px}
.p-lbl{font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--tx3)}
.p-hint{font-size:8px;font-weight:400;letter-spacing:.02em;text-transform:none;color:var(--tx3);opacity:.6}
.p-lbl-row{display:flex;justify-content:space-between;align-items:center}
.p-val{font-family:var(--mono);font-size:9px;color:var(--v3);background:var(--bg3);padding:1px 6px;border-radius:4px;border:1px solid var(--edge)}
.p-sys{
  width:100%;background:var(--bg3);color:var(--tx);
  border:1px solid var(--edge);border-radius:var(--rad);
  font-family:var(--mono);font-size:11px;line-height:1.55;
  padding:7px 10px;outline:none;resize:vertical;min-height:52px;
}
.p-sys:focus{border-color:var(--v2)}.p-sys::placeholder{color:var(--tx3)}
.p-slider{
  width:100%;-webkit-appearance:none;height:3px;border-radius:2px;
  background:var(--edge);outline:none;cursor:pointer;
}
.p-slider::-webkit-slider-thumb{
  -webkit-appearance:none;width:13px;height:13px;border-radius:50%;
  background:var(--v2);border:2px solid var(--bg);box-shadow:0 0 5px var(--v);
}
.p-num{
  width:100%;background:var(--bg3);color:var(--tx);
  border:1px solid var(--edge);border-radius:var(--rad);
  font-family:var(--mono);font-size:12px;padding:5px 10px;outline:none;
}
.p-num:focus{border-color:var(--v2)}
.p-sel{
  width:100%;background:var(--bg3);color:var(--tx);
  border:1px solid var(--edge);border-radius:var(--rad);
  font-family:var(--mono);font-size:11px;padding:5px 10px;outline:none;cursor:pointer;
}
.p-sel:focus{border-color:var(--v2)}
.p-tog-row{display:flex;align-items:center;gap:10px}
.tsw{position:relative;width:36px;height:20px;flex-shrink:0}
.tsw input{opacity:0;width:0;height:0}
.ttrack{
  position:absolute;top:0;left:0;right:0;bottom:0;
  background:var(--edge);border-radius:10px;cursor:pointer;transition:background .2s;
}
.ttrack::before{
  content:'';position:absolute;width:14px;height:14px;border-radius:50%;
  left:3px;bottom:3px;background:var(--tx3);transition:.2s;
}
.tsw input:checked + .ttrack{background:var(--v)}
.tsw input:checked + .ttrack::before{transform:translateX(16px);background:#fff}
.thint{font-family:var(--mono);font-size:8.5px;color:var(--tx3)}

/* Feed */
.feed{flex:1;padding:12px 14px 120px;display:flex;flex-direction:column;gap:11px;overflow-y:auto}

/* Empty */
.empty{
  flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;color:var(--tx3);text-align:center;padding:40px 20px;margin-top:10px;
}
.empty-orb{width:60px;height:60px;color:var(--v);animation:float 3.5s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.empty-title{font-size:15px;font-weight:700;color:var(--tx2)}
.empty-sub{font-size:12px;line-height:1.75;color:var(--tx3)}
kbd{
  display:inline;background:var(--bg3);border:1px solid var(--edge2);
  border-radius:4px;padding:0 5px;font-family:var(--mono);font-size:11px;color:var(--v3);
}

/* Messages */
.msg{display:flex;flex-direction:column;gap:3px;animation:fin .22s cubic-bezier(.16,1,.3,1)}
@keyframes fin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.msg-role{
  font-family:var(--mono);font-size:8px;font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;padding:0 2px;
}
.msg-u .msg-role{color:var(--v3)}.msg-a .msg-role{color:var(--c2)}
.msg-body{
  padding:9px 12px;border-radius:10px;
  font-size:13.5px;line-height:1.6;word-break:break-word;
}
.msg-u .msg-body { background: #7c3aed; color: #ffffff; border-bottom-right-radius: 3px; max-width: 90%; align-self: flex-end; }
.msg-a .msg-body{
  background:var(--glass);border:1px solid var(--edge);
  border-bottom-left-radius:3px;max-width:94%;
}

/* Thinking dots */
.dots{display:flex;gap:5px;align-items:center;padding:11px 12px}
.dots span{
  width:6px;height:6px;border-radius:50%;background:var(--c2);opacity:.25;
  animation:dp 1.4s ease-in-out infinite;
}
.dots span:nth-child(1){animation-delay:0s}.dots span:nth-child(2){animation-delay:.2s}.dots span:nth-child(3){animation-delay:.4s}
@keyframes dp{0%,80%,100%{opacity:.25;transform:scale(.75)}40%{opacity:1;transform:scale(1)}}

/* Footer */
.ft{
  position:fixed;bottom:0;left:0;right:0;max-width:540px;margin:0 auto;
  padding:10px 14px;padding-bottom:max(14px,env(safe-area-inset-bottom,14px));
  background:linear-gradient(0deg,var(--bg) 65%,transparent);
  display:flex;gap:8px;align-items:flex-end;
}
.ft-inp{
  flex:1;background:var(--bg3);color:var(--tx);
  border:1px solid var(--edge2);border-radius:10px;
  font-family:var(--ui);font-size:13px;line-height:1.4;
  padding:9px 12px;outline:none;resize:none;
  min-height:38px;max-height:100px;
  transition:border-color .15s;-webkit-appearance:none;
}
.ft-inp:focus{border-color:var(--v2);background:var(--bg3)}
.ft-inp::placeholder{color:var(--tx3)}
.ft-go{
  flex-shrink:0;width:38px;height:38px;
  background:linear-gradient(135deg,var(--v),var(--v2));
  border:none;border-radius:10px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:17px;font-weight:700;color:#fff;
  box-shadow:0 0 14px #7c3aed44;
  transition:opacity .15s,transform .1s;
}
.ft-go:active{transform:scale(.9);opacity:.8}
.ft-go:disabled{opacity:.28;cursor:not-allowed}
/* Attach button */
.ft-attach{
  flex-shrink:0;width:38px;height:38px;
  background:var(--bg3);border:1px solid var(--edge2);border-radius:10px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:17px;color:var(--tx3);
  transition:border-color .15s,color .15s;-webkit-appearance:none;
}
.ft-attach:hover{border-color:var(--v2);color:var(--v3)}
.ft-attach.has-file{border-color:var(--v2);color:var(--v3);background:#1a0e38}
/* File preview chip above the footer */
.ft-preview{
  display:none;align-items:center;gap:8px;
  padding:6px 14px;background:var(--glass);border-top:1px solid var(--edge);
  font-family:var(--mono);font-size:10px;color:var(--tx2);
}
.ft-preview.visible{display:flex}
.ft-prev-img{width:36px;height:36px;border-radius:6px;object-fit:cover;border:1px solid var(--edge2)}
.ft-prev-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.ft-prev-rm{background:none;border:none;cursor:pointer;color:var(--tx3);font-size:14px;padding:2px 4px;}
.ft-prev-rm:hover{color:var(--r)}
/* ── TTS Avatar ─────────────────────────────────────────────────────────── */
#tts-avatar{
  width:100%;height:100%;
  filter:drop-shadow(0 0 28px #00ffff55);
}
#av-close{
  position:absolute;top:-8px;right:-8px;
  width:22px;height:22px;border-radius:50%;
  background:#1a1630;border:1px solid #7c3aed88;
  color:#c4b5fd;font-size:11px;line-height:22px;text-align:center;
  cursor:pointer;pointer-events:all;
  font-family:var(--mono);font-weight:700;
  display:none;
  z-index:2;
}
#av-wrap.draggable{cursor:grab}
#av-wrap.dragging{cursor:grabbing}
#tts-avatar.visible + #av-close,
#av-close.visible{display:block}
</style>

<script>
(function(){
  var sp=new URLSearchParams(window.location.search);
  var tok=sp.get('token')||sp.get('t')||'';
  var authQ=tok?('?'+(sp.get('token')?'token':'t')+'='+encodeURIComponent(tok)):'';
  var sseTimer=null;
  var lastPartial = '';

  function applyState(d){
    var dot=document.querySelector('.sdot');
    var stxt=document.getElementById('stxt');
    var chip=document.getElementById('chip-status');
    var mic=document.getElementById('sse-mic');
    if(dot) dot.className='sdot'+(d.processing?' busy':d.connected?' ok':'');
    if(stxt) stxt.textContent=d.processing?(d.searching?'🔍 Searching the web...':'⏳ Generating response...'):(d.connected?'🟢 Say "${WAKE_WORD}" then speak':'⚪ Waiting for glasses...');
    if(chip){
      chip.className='chip chip-status '+(d.processing?'chip-thinking':d.connected?'chip-live':'chip-offline');
      chip.textContent=d.processing?'● THINKING':d.connected?'● LIVE':'● OFFLINE';
    }
    if(mic&&d.micMuted!==undefined){
      mic.className='chip chip-mic'+(d.micMuted?' muted':'');
      mic.textContent=d.micMuted?'🔇 MUTED':'🎤 MIC ON';
    }
    if(d.ttsEnabled!==undefined){
      var tc=document.getElementById('chip-tts');
      if(tc){tc.textContent=d.ttsEnabled?'🔊 VOICE ON':'🔇 VOICE OFF';
        if(d.ttsEnabled){tc.classList.remove('off');}else{tc.classList.add('off');}}
    }
    if(d.ttsEngine!==undefined){
      var ec=document.getElementById('chip-engine');
      if(ec) ec.textContent=d.ttsEngine==='kokoro'?'⚡ KOKORO':d.ttsEngine==='elevenlabs_direct'?'☁ ELEVEN (Direct)':'☁ ELEVEN';
    }
    if(d.reload){
      var inp=document.getElementById('ft-inp');
      if(window._transcriptOverlayOpen){
        window._pendingReloadWhileOverlay=true;
      } else if(inp && inp.value.trim().length>0){
        inp.dataset.pendingReload='1';
      } else if(window._brMicRunning){
        _refreshFeed();
      } else {
        window.location.reload();
      }
    }
    document.dispatchEvent(new CustomEvent('geaux:stateupdate',{detail:d}));
  }

  function _refreshFeed(){ fetch('/webview',{credentials:'include'}).then(function(r){return r.ok?r.text():null;}).then(function(html){ if(!html) return; var doc=(new DOMParser()).parseFromString(html,'text/html'); var nf=doc.getElementById('feed'); var cf=document.getElementById('feed'); if(nf&&cf){ cf.innerHTML=nf.innerHTML; cf.scrollTop=cf.scrollHeight; } var ns=doc.querySelector('.scount'); var sbar=document.querySelector('.sbar'); if(sbar){ var os=sbar.querySelector('.scount'); if(ns&&os) os.outerHTML=ns.outerHTML; else if(ns&&!os){ var logBtn=document.getElementById('sbar-log-btn'); if(logBtn) sbar.insertBefore(ns.cloneNode(true),logBtn); } else if(!ns&&os) os.remove(); } }).catch(function(){}); }
  window._refreshFeed = _refreshFeed;

  function applyListening(d){
    var bar=document.getElementById('lbar');
    var txt=document.getElementById('ltxt');
    if(!bar) return;
    if(d.active){
      bar.style.display='flex';
      if(txt){
        txt.textContent=d.partial?d.partial:'Listening…';
        bar.scrollTop=bar.scrollHeight;
      }
    } else {
      bar.style.display='none';
      if(txt) txt.textContent='';
    }
  }

  function safeReload(){
    var inp=document.getElementById('ft-inp');
    if(inp && inp.value.trim().length>0){
      inp.dataset.pendingReload='1';
    } else {
      window.location.reload();
    }
  }

  function connectSSE(){
    var es=new EventSource('/api/stream'+authQ);
    clearTimeout(sseTimer);
    sseTimer=setTimeout(safeReload,120000);
    es.addEventListener('state',function(e){
      clearTimeout(sseTimer);
      sseTimer=setTimeout(safeReload,120000);
      try{applyState(JSON.parse(e.data));}catch(ex){}
    });
    es.addEventListener('keepalive',function(){
      clearTimeout(sseTimer);
      sseTimer=setTimeout(safeReload,120000);
    });
    es.addEventListener('listening', function(e) {
      try {
        var d = JSON.parse(e.data);
        applyListening(d);
        if (d.active && d.partial && d.partial.trim().length > 0) {
          lastPartial = d.partial.trim();
        }
        if (!d.active && lastPartial.length > 0) {
          var now2 = new Date();
          var ts2 = now2.toTimeString().slice(0, 8);
          window.dispatchEvent(new CustomEvent('geaux:transcript', {
            detail: { ts: ts2, text: lastPartial }
          }));
          lastPartial = '';
        }
      } catch(ex) {}
    });
    es.addEventListener('tts_audio', function(e) {
      try {
        var d = JSON.parse(e.data);
        var player = document.getElementById('_kplayer');
        if (!player) {
          player = document.createElement('audio');
          player.id = '_kplayer';
          player.controls = false;
          player.autoplay = true;
          document.body.appendChild(player);
        }
        // Force reload by clearing src first
        player.pause();
        player.removeAttribute('src');
        player.load();
        player.src = d.url + '?t=' + Date.now();
        player.load();
        var p = player.play();
        if (p !== undefined) {
          p.catch(function(err) {
            // Autoplay blocked — show a visible play button as fallback
            var btn = document.getElementById('_kplay_btn');
            if (!btn) {
              btn = document.createElement('button');
              btn.id = '_kplay_btn';
              btn.style.cssText = 'position:fixed;bottom:80px;right:20px;z-index:9999;padding:12px 20px;background:#a855f7;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;';
              btn.textContent = '▶ Play Audio';
              document.body.appendChild(btn);
            }
            btn.style.display = 'block';
            btn.onclick = function() {
              player.play();
              btn.style.display = 'none';
            };
          });
        }
      } catch(ex) {}
    });
    es.onerror=function(){es.close();setTimeout(connectSSE,3000);};
  }
  connectSSE();
})();
</script>
</head>
<body>
<div class="shell">

<header class="hd">
  <div class="hd-brand">
    <img src="/logo.png" class="logo-img" alt="GeauxAI Labs">
    <div class="hd-text">
      <div class="hd-name">GEAUXAI LABS / GEAUXAIPROMPT</div>
    </div>
  </div>
  <div class="hd-right">
    <div id="chip-status" class="chip chip-status ${statusChipClass}">${statusChipLabel}</div>
    <button class="chip chip-tts${ttsEnabled ? '' : ' off'}" id="chip-tts" onclick="toggleTTS()">${ttsChipLabel}</button>
    <button class="chip chip-engine" id="chip-engine" onclick="toggleTTSEngine()">${engineChipLabel}</button>
    <form method="POST" action="/mic" style="margin:0">
      <button type="submit" id="sse-mic" class="chip chip-mic${micMuted ? ' muted' : ''}">${micMuted ? '🔇 MUTED' : '🎤 MIC ON'}</button>
    </form>
    <form method="POST" action="/clear" style="margin:0">
      <button type="submit" class="chip chip-x">✕ CLEAR</button>
    </form>
    <button class="chip chip-theme" id="chip-theme" onclick="toggleTheme()" title="Toggle light/dark theme">🌙</button>
  </div>
</header>

<div class="sbar">
  <div class="sdot ${dotClass}"></div>
  <div class="stxt" id="stxt">${statusText}</div>
  ${promptCount > 0 ? `<span class="scount">${promptCount} prompt${promptCount !== 1 ? 's' : ''}</span>` : ''}
  <button id="sbar-log-btn" onclick="openTranscriptLog()" title="View transcription log" style="background:transparent;border:none;cursor:pointer;font-family:var(--mono);font-size:9px;color:var(--tx3);padding:1px 4px;flex-shrink:0;opacity:0.55;">📋</button>
</div>

<div id="lbar" class="lbar">
  <div class="lwave"><span></span><span></span><span></span><span></span><span></span></div>
  <div id="ltxt" class="ltxt">Listening…</div>
</div>

<div class="params-wrap">
  <button class="params-btn" type="button" onclick="toggleP()" id="params-btn">
    <span>⚙ SYSTEM PROMPT &amp; PARAMETERS</span>
    <span class="params-chev" id="params-chev">▼</span>
  </button>
  <div class="params-body" id="params-body" style="display:none">
    <div class="p-row">
      <span class="p-lbl">MODEL <span class="p-hint">— override default AI model for this session</span></span>
      <select class="p-sel" id="p-model"><option value="">Default (${AI_MODEL})</option></select>
    </div>
    ${ELEVENLABS_API_KEY ? `
<div class="p-row" id="p-row-eleven-path">
  <span class="p-lbl">ELEVENLABS PATH <span class="p-hint">— MentraOS: plays via glasses/phone. GeauxAI: plays directly in browser via API key</span></span>
  <select class="p-sel" id="p-eleven-path"><option value="mentraos">MentraOS (via SDK)</option><option value="geauxai">GeauxAI (direct API)</option></select>
</div>
<div class="p-row" id="p-row-eleven-voice">
  <span class="p-lbl">ELEVEN VOICE — MentraOS <span class="p-hint">— paid library voices, used when ELEVEN (MentraOS) engine is active</span></span>
  <select class="p-sel" id="p-eleven-voice"><option value="">Default (from .env)</option></select>
</div>
<div class="p-row" id="p-row-eleven-direct-voice">
  <span class="p-lbl">ELEVEN VOICE — Direct <span class="p-hint">— free tier premade voices, used when ELEVEN (Direct) engine is active</span></span>
  <select class="p-sel" id="p-eleven-direct-voice"><option value="">Default (Rachel)</option></select>
</div>` : ''}
    ${KOKORO_HOST ? `
<div class="p-row" id="p-row-kokoro-voice">
  <span class="p-lbl">KOKORO VOICE <span class="p-hint">— voice used when KOKORO engine is selected. Supports blending: af_bella+af_sky</span></span>
  <select class="p-sel" id="p-kokoro-voice"><option value="">Default (from .env)</option></select>
</div>` : ''}
    <div class="p-row">
      <span class="p-lbl">AI PROVIDER <span class="p-hint">— switch between local Ollama and Cloudflare cloud AI</span></span>
      <div class="p-tog-row">
        <label class="tsw"><input type="checkbox" id="p-cf"><span class="ttrack"></span></label>
        <span class="thint" id="p-cf-hint">OLLAMA — local models</span>
      </div>
    </div>
    <div class="p-row">
      <span class="p-lbl">WEB SEARCH <span class="p-hint">— inject live results for current events &amp; facts</span></span>
      <div class="p-tog-row">
        <label class="tsw"><input type="checkbox" id="p-ws"><span class="ttrack"></span></label>
        <span class="thint" id="p-ws-hint">OFF — model knowledge only</span>
      </div>
    </div>
    <div class="p-row">
      <span class="p-lbl">BROWSER MIC <span class="p-hint">— enable browser microphone when glasses are offline. No wake word needed. Sends speech directly to AI.</span></span>
      <div class="p-tog-row">
        <label class="tsw"><input type="checkbox" id="p-browser-mic"><span class="ttrack"></span></label>
        <span class="thint" id="p-browser-mic-hint">OFF — browser mic disabled</span>
      </div>
    </div>
    <div class="p-row">
      <span class="p-lbl">TTS AVATAR <span class="p-hint">— show/hide the floating avatar during TTS playback</span></span>
      <div class="p-tog-row">
        <label class="tsw"><input type="checkbox" id="p-avatar" checked><span class="ttrack"></span></label>
        <span class="thint" id="p-avatar-hint">ON — avatar appears during speech</span>
      </div>
    </div>
    <div class="p-row">
      <span class="p-lbl">SYSTEM PROMPT <span class="p-hint">— sets AI persona / behavior for the session</span></span>
      <textarea class="p-sys" id="p-sys" rows="3" placeholder="Optional system prompt…"></textarea>
    </div>
    <div class="p-row">
      <div class="p-lbl-row"><span class="p-lbl">TEMPERATURE <span class="p-hint">— creativity/randomness (0=precise · 1=balanced · 2=wild)</span></span><span class="p-val" id="p-tv">0.70</span></div>
      <input type="range" class="p-slider" id="p-temp" min="0" max="2" step="0.05" value="0.7">
    </div>
    <div class="p-row">
      <div class="p-lbl-row"><span class="p-lbl">TOP P <span class="p-hint">— token diversity (lower=safer word choices · higher=more varied)</span></span><span class="p-val" id="p-pv">0.95</span></div>
      <input type="range" class="p-slider" id="p-topp" min="0" max="1" step="0.05" value="0.95">
    </div>
    <div class="p-row">
      <span class="p-lbl">MAX TOKENS <span class="p-hint">— max length of AI response (256–32000)</span></span>
      <input type="number" class="p-num" id="p-maxtok" min="256" max="32000" value="4096">
    </div>
    <div class="p-row">
      <button id="p-transcript-btn" onclick="openTranscriptLog()" style="width:100%;padding:8px 12px;background:var(--glass);border:1px solid var(--edge);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:var(--v3);text-align:left;">📋 TRANSCRIPTION LOG &nbsp;<span data-tc>(0 entries)</span></button>
    </div>
  </div>
</div>

<div class="feed" id="feed">${bubbles}</div>

<div class="ft-preview" id="ft-preview">
  <img class="ft-prev-img" id="ft-prev-img" src="" alt="" style="display:none">
  <span class="ft-prev-name" id="ft-prev-name"></span>
  <button class="ft-prev-rm" id="ft-prev-rm" title="Remove file">✕</button>
</div>
<!-- TTS avatar -->
<div id="av-wrap" style="position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:100;width:230px;height:230px;display:none;pointer-events:all;">
  <div id="tts-avatar"></div>
  <div id="av-close" onclick="window._avClose && window._avClose()">✕</div>
</div>
<footer class="ft">
  <input type="file" id="ft-file" accept="image/*,audio/*,.pdf,.txt" style="display:none">
  <button class="ft-attach" id="ft-attach" title="Attach image, audio, or document">📎</button>
  <textarea class="ft-inp" id="ft-inp" placeholder="Type a prompt → sends to glasses…" maxlength="10000" rows="1"></textarea>
  <button class="ft-go" id="ft-go" title="Send">↑</button>
</footer>
<div id="transcript-overlay" style="position:fixed;inset:0;z-index:500;background:var(--bg);display:flex;flex-direction:column;transform:translateY(100%);transition:transform 250ms ease;font-family:var(--mono);pointer-events:none;">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--edge);background:var(--bg2);flex-shrink:0;">
    <span style="font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--v3);">\uD83D\uDCCB TRANSCRIPTION LOG <span id="tlog-count" style="opacity:.6;font-weight:400;">(0)</span></span>
    <button onclick="closeTranscriptLog()" style="background:transparent;border:1px solid var(--edge);border-radius:6px;color:var(--tx2);font-size:13px;width:28px;height:28px;cursor:pointer;">✕</button>
  </div>
  <div id="tlog-list" style="flex:1;overflow-y:auto;padding:12px 16px;">
    <div id="tlog-empty" style="text-align:center;color:var(--tx3);font-size:10px;padding:40px 0;letter-spacing:.06em;">No transcriptions yet this session</div>
  </div>
  <div id="ask-ai-pane" style="display:none;flex-direction:column;gap:10px;padding:14px 16px;flex:1;overflow-y:auto;">
    <div style="font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.12em;color:var(--v3);">🤖 ASK AI ABOUT THIS TRANSCRIPT</div>
    <div style="font-family:var(--mono);font-size:9px;color:var(--tx3);line-height:1.5;" id="ask-ai-ctx-info"></div>
    <div id="ask-ai-presets" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
    <textarea id="ask-ai-input" placeholder="Ask anything about the transcript…" rows="3" style="width:100%;background:var(--bg3);color:var(--tx);border:1px solid var(--edge);border-radius:var(--rad);font-family:var(--mono);font-size:11px;line-height:1.55;padding:8px 10px;outline:none;resize:vertical;min-height:60px;"></textarea>
    <div style="display:flex;gap:8px;">
      <button type="button" onclick="closeAskAIPane()" style="flex:1;padding:10px;background:var(--glass);border:1px solid var(--edge);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.10em;color:var(--tx3);">← BACK</button>
      <button id="ask-ai-submit" type="button" style="flex:2;padding:10px;background:var(--glass);border:1px solid var(--v2);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;letter-spacing:.10em;color:var(--v3);" onclick="submitAskAI()">🤖 SEND TO AI</button>
    </div>
  </div>
  <div id="tlog-footer" style="display:flex;gap:6px;padding:12px 16px;padding-bottom:max(12px,env(safe-area-inset-bottom,16px));border-top:1px solid var(--edge);background:var(--bg2);flex-shrink:0;">
    <button onclick="clearTranscriptLog()" style="flex:1;min-width:0;padding:9px 4px;background:var(--glass);border:1px solid var(--edge);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.10em;color:var(--r);">\uD83D\uDDD1 CLEAR</button>
    <button onclick="saveTranscriptLog()" style="flex:1;min-width:0;padding:9px 4px;background:var(--glass);border:1px solid var(--edge);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.10em;color:var(--g2);">\uD83D\uDCBE SAVE .TXT</button>
    <button onclick="resetSpeakers()" style="flex:1;min-width:0;padding:9px 4px;background:var(--glass);border:1px solid var(--edge);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.10em;color:var(--a);">🔄 RESET SPKRS</button>
    <button onclick="openAskAIPane()" style="flex:1;min-width:0;padding:9px 4px;background:var(--glass);border:1px solid var(--v2);border-radius:var(--rad);cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;letter-spacing:.10em;color:var(--v3);">🤖 ASK AI</button>
  </div>
</div>
</div>

<script>
(function(){
  var sp=new URLSearchParams(window.location.search);
  var tok=sp.get('token')||sp.get('t')||'';
  var authQ=tok?('?'+(sp.get('token')?'token':'t')+'='+encodeURIComponent(tok)):'';
  var brWakeWord='${WAKE_WORD}';
  var pOpen=false;
  var transcriptLog=(function(){try{var s=localStorage.getItem('geaux_tlog');return s?JSON.parse(s):[];}catch(e){return [];}})();
  var overlayOpen=false;
  var _nextSpeaker         = 1;
  var _lastSpeaker         = 1;
  var _speakerGapMs        = 3500;
  var _speakerGapCalibrated = false;

  window.toggleP=function(){
    pOpen=!pOpen;
    var b=document.getElementById('params-body');
    var c=document.getElementById('params-chev');
    if(b) b.style.display=pOpen?'flex':'none';
    if(c) c.textContent=pOpen?'▲':'▼';
  };

  function deb(fn,ms){var t;return function(){clearTimeout(t);t=setTimeout(fn,ms);};}

  function sendParams(){
    var sys=document.getElementById('p-sys');
    var temp=document.getElementById('p-temp');
    var topp=document.getElementById('p-topp');
    var mt=document.getElementById('p-maxtok');
    var mdl=document.getElementById('p-model');
    var ws=document.getElementById('p-ws');
    var cf=document.getElementById('p-cf');
    var elevVoiceEl=document.getElementById('p-eleven-voice');
    var kokoroVoiceEl=document.getElementById('p-kokoro-voice');
    var avatarEl=document.getElementById('p-avatar');
    if(!sys||!temp||!topp||!mt) return;
    fetch('/api/params'+authQ,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        systemPrompt:sys.value,temperature:parseFloat(temp.value),
        topP:parseFloat(topp.value),maxTokens:parseInt(mt.value,10)||2048,
        model:mdl?mdl.value:'',webSearch:ws?ws.checked:true,
        useCloudflare:cf?cf.checked:false,
        elevenPathPref:document.getElementById('p-eleven-path')?document.getElementById('p-eleven-path').value:'mentraos',
        elevenLabsVoiceId:elevVoiceEl?elevVoiceEl.value:'',
        elevenDirectVoiceId:document.getElementById('p-eleven-direct-voice')?document.getElementById('p-eleven-direct-voice').value:'',
        kokoroVoice:kokoroVoiceEl?kokoroVoiceEl.value:''
        ,avatarEnabled:avatarEl?!!avatarEl.checked:true
        ,browserMicEnabled:document.getElementById('p-browser-mic')?!!document.getElementById('p-browser-mic').checked:false
      })
    }).catch(function(){});
  }
  var dSend=deb(sendParams,600);

  var pendingMdl='';
  function refreshModels(provider){
    var url='/api/models'+(provider==='cloudflare'?'?provider=cloudflare':'');
    fetch(url)
      .then(function(r){return r.ok?r.json():null;})
      .then(function(d){
        if(!d||!d.models) return;
        var sel=document.getElementById('p-model');
        if(!sel) return;
        // Clear existing options except the first (default)
        while(sel.options.length>1) sel.remove(1);
        // Update default option text
        sel.options[0].textContent='Default ('+d.default+')';
        d.models.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;sel.appendChild(o);});
        if(pendingMdl) sel.value=pendingMdl;
      }).catch(function(){});
  }
  function refreshElevenVoices(selectedId) {
    fetch('/api/elevenlabs-voices' + authQ)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.voices) return;
        var sel = document.getElementById('p-eleven-voice');
        if (!sel) return;
        while (sel.options.length > 1) sel.remove(1);
        d.voices.forEach(function(v){
          var opt = document.createElement('option');
          opt.value = v.voice_id;
          opt.textContent = v.name;
          if (selectedId && v.voice_id === selectedId) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(function(){});
  }
  function refreshElevenDirectVoices(selectedId) {
    fetch('/api/elevenlabs-voices-free' + authQ)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.voices) return;
        var sel = document.getElementById('p-eleven-direct-voice');
        if (!sel) return;
        while (sel.options.length > 1) sel.remove(1);
        d.voices.forEach(function(v){
          var opt = document.createElement('option');
          opt.value = v.voice_id;
          opt.textContent = v.name;
          if (selectedId && v.voice_id === selectedId) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(function(){});
  }
  function refreshKokoroVoices(selectedId) {
    fetch('/api/kokoro-voices' + authQ)
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(d){
        if (!d || !d.voices) return;
        var sel = document.getElementById('p-kokoro-voice');
        if (!sel) return;
        while (sel.options.length > 1) sel.remove(1);
        d.voices.forEach(function(v){
          var opt = document.createElement('option');
          opt.value = v;
          opt.textContent = v;
          if (selectedId && v === selectedId) opt.selected = true;
          sel.appendChild(opt);
        });
      }).catch(function(){});
  }
  // Initial load
  refreshModels('ollama');
  refreshElevenVoices();
  refreshElevenDirectVoices();
  refreshKokoroVoices();

  fetch('/api/params'+authQ)
    .then(function(r){return r.ok?r.json():null;})
    .then(function(d){
      if(!d) return;
      var sys=document.getElementById('p-sys');
      var temp=document.getElementById('p-temp');
      var tv=document.getElementById('p-tv');
      var topp=document.getElementById('p-topp');
      var pv=document.getElementById('p-pv');
      var mt=document.getElementById('p-maxtok');
      var mdl=document.getElementById('p-model');
      var ws=document.getElementById('p-ws');
      var wsh=document.getElementById('p-ws-hint');
      if(sys) sys.value=d.systemPrompt||'';
      if(temp&&tv){temp.value=d.temperature;tv.textContent=parseFloat(d.temperature).toFixed(2);}
      if(topp&&pv){topp.value=d.topP;pv.textContent=parseFloat(d.topP).toFixed(2);}
      if(mt) mt.value=d.maxTokens;
      if(d.model!==undefined){pendingMdl=d.model;if(mdl) mdl.value=d.model;}
      if(ws&&d.webSearch!==undefined){
        ws.checked=!!d.webSearch;
        if(wsh) wsh.textContent=d.webSearch?'🔍 ON — live web results injected':'OFF — model knowledge only';
      }
      var cf=document.getElementById('p-cf');
      var cfh=document.getElementById('p-cf-hint');
      if(cf&&d.useCloudflare!==undefined){
        cf.checked=!!d.useCloudflare;
        if(cfh) cfh.textContent=d.useCloudflare?'☁ CLOUDFLARE — cloud AI models':'OLLAMA — local models';
        // Refresh model list for the right provider
        refreshModels(d.useCloudflare?'cloudflare':'ollama');
      }
      refreshElevenVoices(d.elevenLabsVoiceId || '');
      refreshElevenDirectVoices(d.elevenDirectVoiceId || '');
      var _ep=document.getElementById('p-eleven-path'); if(_ep && d.elevenPathPref) _ep.value=d.elevenPathPref;
      refreshKokoroVoices(d.kokoroVoice || '');
      var avatarEl=document.getElementById('p-avatar');
      var avatarHint=document.getElementById('p-avatar-hint');
      if(avatarEl&&d.avatarEnabled!==undefined){
        avatarEl.checked=!!d.avatarEnabled;
        if(avatarHint) avatarHint.textContent=d.avatarEnabled?'ON — avatar appears during speech':'OFF — avatar hidden';
      }
      var bmEl=document.getElementById('p-browser-mic'); var bmHint=document.getElementById('p-browser-mic-hint'); if(bmEl&&d.browserMicEnabled!==undefined){bmEl.checked=!!d.browserMicEnabled; if(bmHint) bmHint.textContent=d.browserMicEnabled?'ON — browser mic active when offline':'OFF — browser mic disabled'; if(d.browserMicEnabled && !_glassesConnected){ setTimeout(_startBrowserMic, 800); }}
    }).catch(function(){});

  var tempEl=document.getElementById('p-temp'),tvEl=document.getElementById('p-tv');
  if(tempEl&&tvEl){
    tempEl.addEventListener('input',function(){tvEl.textContent=parseFloat(this.value).toFixed(2);});
    tempEl.addEventListener('change',sendParams);
  }
  var toppEl=document.getElementById('p-topp'),pvEl=document.getElementById('p-pv');
  if(toppEl&&pvEl){
    toppEl.addEventListener('input',function(){pvEl.textContent=parseFloat(this.value).toFixed(2);});
    toppEl.addEventListener('change',sendParams);
  }
  var mdlEl=document.getElementById('p-model');
  if(mdlEl) mdlEl.addEventListener('change',sendParams);
  var wsEl=document.getElementById('p-ws'),wshEl=document.getElementById('p-ws-hint');
  if(wsEl) wsEl.addEventListener('change',function(){
    var on=wsEl.checked;
    if(wshEl) wshEl.textContent=on?'🔍 ON — live web results injected':'OFF — model knowledge only';
    fetch('/api/params'+authQ,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({webSearch:on})}).catch(function(){});
  });
  var cfEl=document.getElementById('p-cf'),cfhEl=document.getElementById('p-cf-hint');
  if(cfEl) cfEl.addEventListener('change',function(){
    var on=cfEl.checked;
    if(cfhEl) cfhEl.textContent=on?'☁ CLOUDFLARE — cloud AI models':'OLLAMA — local models';
    // Clear selected model when switching providers
    var mdlSel=document.getElementById('p-model');
    if(mdlSel) mdlSel.value='';
    pendingMdl='';
    // Refresh model dropdown for the new provider
    refreshModels(on?'cloudflare':'ollama');
    // Save immediately
    fetch('/api/params'+authQ,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({useCloudflare:on,model:''})}).catch(function(){});
  });
  var mtEl=document.getElementById('p-maxtok');
  if(mtEl){mtEl.addEventListener('change',sendParams);mtEl.addEventListener('blur',sendParams);}
  var sysEl=document.getElementById('p-sys');
  if(sysEl){sysEl.addEventListener('blur',sendParams);sysEl.addEventListener('input',dSend);}
  var elevenPathEl=document.getElementById('p-eleven-path'); if(elevenPathEl) elevenPathEl.addEventListener('change',sendParams);
  var elevVoiceEl = document.getElementById('p-eleven-voice');
  if (elevVoiceEl) elevVoiceEl.addEventListener('change', sendParams);
  var elevDirectVoiceEl=document.getElementById('p-eleven-direct-voice'); if(elevDirectVoiceEl) elevDirectVoiceEl.addEventListener('change',sendParams);
  var kokoroVoiceEl = document.getElementById('p-kokoro-voice');
  if (kokoroVoiceEl) kokoroVoiceEl.addEventListener('change', sendParams);
  var bmTogEl=document.getElementById('p-browser-mic'); var bmTogHint=document.getElementById('p-browser-mic-hint');
  if(bmTogEl) bmTogEl.addEventListener('change',function(){ var on=bmTogEl.checked; if(bmTogHint) bmTogHint.textContent=on?'ON — browser mic active when offline':'OFF — browser mic disabled'; fetch('/api/params'+authQ,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browserMicEnabled:on})}).catch(function(){}); if(on && !_glassesConnected){ _startBrowserMic(); } else { _stopBrowserMic(); } });
  var micFormBtn=document.getElementById('sse-mic'); if(micFormBtn){ micFormBtn.closest('form').addEventListener('submit',function(ev){ if(_brEnabled){ ev.preventDefault(); var isMuted=micFormBtn.classList.contains('muted'); micFormBtn.classList.toggle('muted',!isMuted); micFormBtn.textContent=isMuted?'🎤 MIC ON':'🔇 MUTED'; fetch('/mic'+authQ,{method:'POST'}).catch(function(){}); } }); }
  var avTogEl=document.getElementById('p-avatar');
  var avTogHint=document.getElementById('p-avatar-hint');
  if(avTogEl) avTogEl.addEventListener('change',function(){
    var on=avTogEl.checked;
    if(avTogHint) avTogHint.textContent=on?'ON — avatar appears during speech':'OFF — avatar hidden';
    fetch('/api/params'+authQ,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatarEnabled:on})}).catch(function(){});
  });

  window.toggleTheme=function(){ var html=document.documentElement; var isLight=html.getAttribute('data-theme')==='light'; html.setAttribute('data-theme',isLight?'dark':'light'); var btn=document.getElementById('chip-theme'); if(btn) btn.textContent=isLight?'🌙':'☀️'; try{localStorage.setItem('geauxai-theme',isLight?'dark':'light');}catch(e){} };
  (function(){ try{ var t=localStorage.getItem('geauxai-theme'); if(t==='light'){ document.documentElement.setAttribute('data-theme','light'); var btn=document.getElementById('chip-theme'); if(btn) btn.textContent='☀️'; } }catch(e){} })();

  window.toggleTTSEngine=function(){
    fetch('/tts-engine'+authQ,{method:'POST'})
      .then(function(r){return r.json();})
      .then(function(d){
        var chip=document.getElementById('chip-engine');
        if(chip) chip.textContent=d.ttsEngine==='kokoro'?'⚡ KOKORO':d.ttsEngine==='elevenlabs_direct'?'☁ ELEVEN (Direct)':'☁ ELEVEN';
      }).catch(function(){});
  };

  window.toggleTTS=function(){
    fetch('/tts'+authQ,{method:'POST'})
      .then(function(r){return r.json();})
      .then(function(d){
        var chip=document.getElementById('chip-tts');
        if(chip){chip.textContent=d.ttsEnabled?'🔊 VOICE ON':'🔇 VOICE OFF';
          if(d.ttsEnabled){chip.classList.remove('off');}else{chip.classList.add('off');}}
      }).catch(function(){});
  };

  // ── Transcript Log ────────────────────────────────────────────────────
  function tlogSave(){
    try{localStorage.setItem('geaux_tlog',JSON.stringify(transcriptLog));}catch(e){}
  }

  function tlogUpdateCount(){
    var n=transcriptLog.length;
    var c=document.getElementById('tlog-count');
    if(c) c.textContent='('+n+')';
    var b=document.getElementById('p-transcript-btn');
    if(b){var s=b.querySelector('span[data-tc]');if(s) s.textContent='('+n+(n===1?' entry':' entries')+')';}  }

  function tlogRender(){
    var list=document.getElementById('tlog-list');
    var empty=document.getElementById('tlog-empty');
    if(!list) return;
    list.querySelectorAll('.tlog-row').forEach(function(r){r.remove();});
    var existSum=document.getElementById('tlog-summary');
    if(existSum) existSum.remove();
    if(transcriptLog.length===0){if(empty) empty.style.display='block';return;}
    if(empty) empty.style.display='none';
    // Speaker color palette — hardcoded hex (CSS vars cannot be concatenated with alpha suffixes)
    var spkrHex=['#c4b5fd','#67e8f9','#34d399','#f59e0b','#f472b6','#94a3b8'];
    function spkrColor(n){return (n>=1&&n<=5)?spkrHex[n-1]:spkrHex[5];}
    // Summary bar
    var spkrSet=new Set();
    transcriptLog.forEach(function(e){if(e.speaker!==undefined) spkrSet.add(e.speaker);});
    var maxGap=0;
    for(var si=0;si<transcriptLog.length-1;si++){
      var sg=Math.abs((transcriptLog[si].tsMs||0)-(transcriptLog[si+1].tsMs||0));
      if(sg>maxGap) maxGap=sg;
    }
    var sumDiv=document.createElement('div');
    sumDiv.id='tlog-summary';
    sumDiv.style.cssText='font-family:var(--mono);font-size:8.5px;color:var(--tx3);padding:6px 0 10px;letter-spacing:.06em;border-bottom:1px solid var(--edge);margin-bottom:8px;';
    sumDiv.textContent=spkrSet.size+(spkrSet.size!==1?' speakers':' speaker')+' detected · longest gap: '+maxGap+'ms · '+transcriptLog.length+(transcriptLog.length!==1?' utterances':' utterance');
    list.insertBefore(sumDiv,list.firstChild);
    // Rows
    transcriptLog.forEach(function(entry){
      var spk=entry.speaker!==undefined?entry.speaker:1;
      var color=spkrColor(spk);
      var row=document.createElement('div');
      row.className='tlog-row';
      row.style.cssText='padding:7px 0;border-bottom:1px solid var(--edge);font-size:10px;line-height:1.5;color:var(--tx);display:flex;gap:10px;align-items:flex-start;';
      var ts=document.createElement('span');
      ts.style.cssText='color:var(--v3);flex-shrink:0;font-size:9px;padding-top:1px;';
      ts.textContent='['+entry.ts+']';
      var chip=document.createElement('span');
      chip.style.cssText='font-size:8px;font-weight:700;letter-spacing:.10em;padding:1px 5px;border-radius:3px;border:1px solid '+color+'40;color:'+color+';background:'+color+'10;flex-shrink:0;margin-right:2px;';
      chip.textContent='SPKR '+(entry.speaker!==undefined?entry.speaker:'?');
      var txt=document.createElement('span');
      txt.style.cssText='flex:1;word-break:break-word;';
      txt.textContent=entry.text;
      row.appendChild(ts);row.appendChild(chip);row.appendChild(txt);
      list.appendChild(row);
    });
  }

  window.openTranscriptLog=function(){
    overlayOpen=true;window._transcriptOverlayOpen=true;
    var ov=document.getElementById('transcript-overlay');
    if(ov){ov.style.transform='translateY(0)';ov.style.pointerEvents='auto';}
    tlogRender();
  };

  window.closeTranscriptLog=function(){
    overlayOpen=false;window._transcriptOverlayOpen=false;
    var ov=document.getElementById('transcript-overlay');
    if(ov){ov.style.transform='translateY(100%)';ov.style.pointerEvents='none';}
    if(window._pendingReloadWhileOverlay){window._pendingReloadWhileOverlay=false;if(window._brMicRunning&&window._refreshFeed){window._refreshFeed();}else{window.location.reload();}}
  };

  window.clearTranscriptLog=function(){
    transcriptLog=[];tlogSave();tlogUpdateCount();tlogRender();
  };

  window.saveTranscriptLog=function(){
    if(transcriptLog.length===0) return;
    var now=new Date();
    var header='GeauxAI Transcription Log \u2014 '+now.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})+' '+now.toLocaleTimeString('en-US');
    var lines=[header,'\u2500'.repeat(50),''];
    transcriptLog.slice().reverse().forEach(function(e){lines.push('['+e.ts+'] [SPKR '+(e.speaker!==undefined?e.speaker:'?')+'] '+e.text);});
    var content=lines.join(String.fromCharCode(10));
    var yyyy=now.getFullYear(),mm=String(now.getMonth()+1).padStart(2,'0'),dd=String(now.getDate()).padStart(2,'0');
    var filename='geauxai-transcript-'+yyyy+'-'+mm+'-'+dd+'.txt';
    if(typeof window.showSaveFilePicker==='function'){
      window.showSaveFilePicker({
        suggestedName:filename,
        types:[{description:'Text File',accept:{'text/plain':['.txt']}}]
      }).then(function(fh){return fh.createWritable();})
        .then(function(w){return w.write(content).then(function(){return w.close();});})
        .catch(function(err){if(err&&err.name!=='AbortError'){console.warn('showSaveFilePicker failed, falling back',err);}});
    } else {
      var blob=new Blob([content],{type:'text/plain'});
      var url=URL.createObjectURL(blob);
      var a=document.createElement('a');
      a.href=url;
      a.download=filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(url);},200);
    }
  };

  window.addEventListener('geaux:transcript',function(e){
    var tsMs = Date.now();
    var ts = e.detail.ts;
    var text = e.detail.text;
    var speaker;
    if(transcriptLog.length === 0){
      speaker = 1;
      _lastSpeaker = 1;
      _nextSpeaker = 2;
    } else {
      var prev = transcriptLog[0];
      var gapMs = tsMs - (prev.tsMs || 0);
      if(gapMs > _speakerGapMs){
        speaker = _nextSpeaker;
        _lastSpeaker = _nextSpeaker;
        _nextSpeaker++;
      } else {
        speaker = _lastSpeaker;
      }
    }
    transcriptLog.unshift({ts:ts, text:text, speaker:speaker, tsMs:tsMs});
    tlogSave();
    tlogUpdateCount();
    if(overlayOpen) tlogRender();
    // AI calibration: fire once after 5th entry
    if(transcriptLog.length === 5 && !_speakerGapCalibrated){
      _speakerGapCalibrated = true;
      var reversed = transcriptLog.slice().reverse();
      var calEntries = reversed.map(function(en, i){
        var gap = i === 0 ? 0 : Math.abs((en.tsMs||0) - (reversed[i-1].tsMs||0));
        return {ts: en.ts, text: en.text, gapMs: gap};
      });
      fetch('/api/calibrate-speaker-gap'+authQ,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({entries:calEntries})
      }).then(function(r){return r.ok?r.json():null;})
        .then(function(d){
          if(d && typeof d.gapMs === 'number'){
            _speakerGapMs = d.gapMs;
            console.log('[SpeakerCalib] gap set to', d.gapMs, 'ms');
          }
        }).catch(function(){});
    }
  });

  // Auto-resize textarea
  var inp=document.getElementById('ft-inp');
  if(inp) inp.addEventListener('input',function(){this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px';});

  // ── Speaker diarization helpers ───────────────────────────────────────
  window.resetSpeakers = function(){
    _nextSpeaker = 1;
    _lastSpeaker = 1;
    _speakerGapCalibrated = false;
    _speakerGapMs = 3500;
    console.log('[Speaker] Reset to Speaker 1');
  };

  // ── Ask AI about transcript ───────────────────────────────────────────
  window.openAskAIPane = function(){
    var pane = document.getElementById('ask-ai-pane');
    var tll  = document.getElementById('tlog-list');
    var tfoot= document.getElementById('tlog-footer');
    if(!pane) return;
    // Populate context info
    var spkSet=new Set();
    transcriptLog.forEach(function(e){if(e.speaker!==undefined) spkSet.add(e.speaker);});
    var oldest = transcriptLog.length ? transcriptLog[transcriptLog.length-1].ts : '—';
    var newest = transcriptLog.length ? transcriptLog[0].ts : '—';
    var info = document.getElementById('ask-ai-ctx-info');
    if(info) info.textContent = transcriptLog.length+' entries · '+spkSet.size+' speaker(s) detected · '+oldest+' to '+newest;
    // Preset chips
    var presetsEl = document.getElementById('ask-ai-presets');
    if(presetsEl){
      presetsEl.innerHTML='';
      var presets=['Summarize this conversation','What were the key decisions?','List action items','Who spoke the most?','What topics were discussed?','Draft follow-up email'];
      presets.forEach(function(p){
        var chip=document.createElement('button');
        chip.type='button';
        chip.style.cssText='font-family:var(--mono);font-size:8.5px;font-weight:700;letter-spacing:.07em;padding:5px 10px;border-radius:99px;border:1px solid #a855f740;color:#c4b5fd;background:#7c3aed10;cursor:pointer;';
        chip.textContent=p;
        chip.onclick=function(){
          var ta=document.getElementById('ask-ai-input');
          if(ta) ta.value=p;
        };
        presetsEl.appendChild(chip);
      });
    }
    // Default value
    var ta=document.getElementById('ask-ai-input');
    if(ta) ta.value='Summarize this conversation';
    // Show pane, hide list and footer
    pane.style.display='flex';
    if(tll) tll.style.display='none';
    if(tfoot) tfoot.style.display='none';
    if(ta) ta.focus();
  };

  window.submitAskAI = function(){
    var question = (document.getElementById('ask-ai-input')||{}).value;
    if(!question || !question.trim()) return;
    question = question.trim();
    var btn = document.getElementById('ask-ai-submit');
    if(btn){ btn.disabled=true; btn.textContent='⏳ Sending…'; }
    // Build chronological transcript (log is newest-first, so reverse it)
    var entries = transcriptLog.slice().reverse();
    var lines = entries.map(function(e){
      return '['+e.ts+'] [SPKR '+(e.speaker||'?')+'] '+e.text;
    });
    var startTs = entries.length ? entries[0].ts : '';
    var endTs   = entries.length ? entries[entries.length-1].ts : '';
    var spkCount=new Set(entries.map(function(e){return e.speaker;})).size;
    var contextBlock='[TRANSCRIPT '+startTs+' to '+endTs+' | '+entries.length+' utterances | '+spkCount+' speaker(s)]'+String.fromCharCode(10)+lines.join(String.fromCharCode(10))+String.fromCharCode(10)+'[END TRANSCRIPT]';
    var fullPrompt = contextBlock+String.fromCharCode(10)+String.fromCharCode(10)+question;
    fetch('/prompt'+authQ,{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'text='+encodeURIComponent(fullPrompt)
    }).then(function(){
      window.closeAskAIPane();
      window.closeTranscriptLog();
    }).catch(function(){
      if(btn){btn.disabled=false;btn.textContent='🤖 SEND TO AI';}
    });
  };

  window.closeAskAIPane = function(){
    var pane  = document.getElementById('ask-ai-pane');
    var tll   = document.getElementById('tlog-list');
    var tfoot = document.getElementById('tlog-footer');
    var btn   = document.getElementById('ask-ai-submit');
    if(pane)  pane.style.display  = 'none';
    if(tll)   tll.style.display   = 'block';
    if(tfoot) tfoot.style.display = 'flex';
    if(btn){btn.disabled=false;btn.textContent='🤖 SEND TO AI';}
  };

  // AJAX send (no page reload)
  var btn=document.getElementById('ft-go');

  var attachedFile = null; // holds the File object if user picked one

  // Attach button click — open file picker
  var attachBtn = document.getElementById('ft-attach');
  var fileInput = document.getElementById('ft-file');
  var preview   = document.getElementById('ft-preview');
  var prevImg   = document.getElementById('ft-prev-img');
  var prevName  = document.getElementById('ft-prev-name');
  var prevRm    = document.getElementById('ft-prev-rm');

  if(attachBtn && fileInput) {
    attachBtn.addEventListener('click', function(){ fileInput.click(); });
    fileInput.addEventListener('change', function(){
      var f = fileInput.files && fileInput.files[0];
      if(!f) return;
      attachedFile = f;
      attachBtn.classList.add('has-file');
      if(preview) preview.classList.add('visible');
      if(prevName) prevName.textContent = f.name + ' (' + (f.size > 1024*1024 ? (f.size/1024/1024).toFixed(1)+'MB' : (f.size/1024).toFixed(0)+'KB') + ')';
      // Show image preview if it's an image
      if(prevImg){
        if(f.type.startsWith('image/')){
          var reader = new FileReader();
          reader.onload = function(ev){ prevImg.src = ev.target.result; prevImg.style.display='block'; };
          reader.readAsDataURL(f);
        } else {
          prevImg.style.display = 'none';
          prevImg.src = '';
        }
      }
      // Clear the input so the same file can be re-selected
      fileInput.value = '';
    });
  }

  if(prevRm) {
    prevRm.addEventListener('click', function(){
      attachedFile = null;
      if(attachBtn) attachBtn.classList.remove('has-file');
      if(preview) preview.classList.remove('visible');
      if(prevImg){ prevImg.src=''; prevImg.style.display='none'; }
      if(prevName) prevName.textContent = '';
    });
  }

  function doSend(){
    (function(){ var p=document.getElementById('_kplayer'); if(!p){p=document.createElement('audio');p.id='_kplayer';p.autoplay=true;document.body.appendChild(p);} p.pause(); p.src=''; p.muted=true; var s=p.play(); if(s) s.then(function(){p.muted=false;}).catch(function(){}); })();
    var text = inp ? inp.value.trim() : '';
    // Require either text OR a file (or both)
    if(!text && !attachedFile) return;
    btn.disabled = true;

    var onDone = function(){
      if(inp){ inp.value=''; inp.style.height='auto'; }
      // Clear attachment
      attachedFile = null;
      if(attachBtn) attachBtn.classList.remove('has-file');
      if(preview) preview.classList.remove('visible');
      if(prevImg){ prevImg.src=''; prevImg.style.display='none'; }
      if(prevName) prevName.textContent='';
      btn.disabled = false;
      if(inp && inp.dataset.pendingReload){
        delete inp.dataset.pendingReload;
        window.location.reload();
      }
    };

    if(attachedFile){
      // File attached — send as multipart to /upload
      var fd = new FormData();
      fd.append('text', text || '');
      fd.append('file', attachedFile, attachedFile.name);
      fetch('/upload'+authQ, { method:'POST', body:fd })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(d.error){
            // Show error inline in the chat (server error, e.g. wrong model)
            alert('⚠️ ' + d.error);
          }
          onDone();
        })
        .catch(function(){ btn.disabled=false; });
    } else {
      // No file — send text only to /prompt as before (unchanged behavior)
      fetch('/prompt'+authQ, {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'text='+encodeURIComponent(text)
      }).then(onDone).catch(function(){ btn.disabled=false; });
    }
  }
  if(btn) btn.addEventListener('click',doSend);
  if(inp) inp.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();}});

  // ── Browser Mic (Web Speech API) — offline path ───────────────────
  var _glassesConnected = false;
  var _browserMicActive = false;
  var _browserMicMuted  = false;
  var _brRecog          = null;
  var _brRestarting     = false;
  var _brEnabled        = false;
  var _brLastSent       = '';
  var _brLastSentTime   = 0;
  var _brNoSpeechBackoff = false;
  var _brAborted        = false;

  function _startBrowserMic(){
    _brEnabled = true; window._brMicRunning = true;
    if(_browserMicActive) return;
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){ console.warn('[BrowserMic] SpeechRecognition not supported'); return; }
    if(_brRecog){ try{ _brRecog.stop(); }catch(e){} _brRecog=null; }
    var r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onstart = function(){ _browserMicActive=true; _brNoSpeechBackoff=false; _brAborted=false; console.log('[BrowserMic] started'); };
    r.onerror = function(ev){ _browserMicActive=false; if(ev.error==='not-allowed'||ev.error==='service-not-allowed'){ console.warn('[BrowserMic] permission denied'); _brEnabled=false; window._brMicRunning=false; var bm=document.getElementById('p-browser-mic'); if(bm) bm.checked=false; var bh=document.getElementById('p-browser-mic-hint'); if(bh) bh.textContent='OFF \u2014 microphone permission denied'; fetch('/api/params'+authQ,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browserMicEnabled:false})}).catch(function(){}); } else if(ev.error==='no-speech'){ _brNoSpeechBackoff=true; } else if(ev.error==='aborted'){ _brAborted=true; } else { console.warn('[BrowserMic] error:',ev.error); } };
    r.onend = function(){ _browserMicActive=false; _brRecog=null; if(!_brEnabled || _glassesConnected || _browserMicMuted || _brRestarting) return; _brRestarting=true; var delay=_brNoSpeechBackoff?1500:(_brAborted?500:250); _brNoSpeechBackoff=false; _brAborted=false; setTimeout(function(){ _brRestarting=false; if(_brEnabled && !_glassesConnected && !_browserMicMuted) _startBrowserMic(); }, delay); };
    r.onresult = function(ev){ if(_browserMicMuted||_glassesConnected) return; var interim=''; var final_=''; for(var i=ev.resultIndex;i<ev.results.length;i++){ if(ev.results[i].isFinal){ final_+=ev.results[i][0].transcript; } else { interim+=ev.results[i][0].transcript; } } if(interim.trim()){ var lb=document.getElementById('lbar'); var lt=document.getElementById('ltxt'); if(lb) lb.style.display='flex'; if(lt) lt.textContent=interim; } if(final_.trim()){ var fLow=final_.trim().toLowerCase(); if(!fLow.startsWith(brWakeWord)) return; var stripped=final_.trim().slice(brWakeWord.length).replace(/^[,\s]+/,'').trim(); if(!stripped) return; var now3=new Date(); var nowMs=now3.getTime(); if(stripped===_brLastSent && nowMs-_brLastSentTime<4000) return; _brLastSent=stripped; _brLastSentTime=nowMs; var ts3=now3.toTimeString().slice(0,8); var lb2=document.getElementById('lbar'); if(lb2) lb2.style.display='none'; var lt2=document.getElementById('ltxt'); if(lt2) lt2.textContent=''; console.log('[BrowserMic] wake word: '+stripped); window.dispatchEvent(new CustomEvent('geaux:transcript',{detail:{ts:ts3,text:final_.trim()}})); fetch('/prompt'+authQ,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'text='+encodeURIComponent(stripped)}).catch(function(){}); } };
    _brRecog = r;
    try{ r.start(); } catch(e){ console.warn('[BrowserMic] start failed:',e); _browserMicActive=false; }
  }

  function _stopBrowserMic(){
    _brEnabled=false; window._brMicRunning=false;
    _brRestarting=false; _brNoSpeechBackoff=false; _brAborted=false;
    _browserMicActive=false;
    if(_brRecog){ try{ _brRecog.stop(); }catch(e){} _brRecog=null; }
    var lb=document.getElementById('lbar'); if(lb) lb.style.display='none';
    console.log('[BrowserMic] stopped');
  }

  // Hook into SSE state to track glasses connection and mute state
  var _origApplyState = window._applyStateFn || null;
  document.addEventListener('geaux:stateupdate', function(ev){
    var d = ev.detail;
    var wasConnected = _glassesConnected;
    _glassesConnected = !!d.connected;
    _browserMicMuted  = !!d.micMuted;
    // Glasses just connected — stop browser mic immediately
    if(!wasConnected && _glassesConnected && _browserMicActive){ _stopBrowserMic(); console.log('[BrowserMic] glasses connected — stopped browser mic'); }
    // Glasses just disconnected — restart browser mic if enabled
    if(wasConnected && !_glassesConnected && _brEnabled && !_browserMicMuted){ _startBrowserMic(); }
  });

  // Scroll feed to bottom
  var feed=document.getElementById('feed');
  if(feed) feed.scrollTop=feed.scrollHeight;
})();
</script>
<script>
/* ── TTS Avatar — Lottie waveform ────────────────────────────────── */
(function(){
  var wrap      = document.getElementById('av-wrap');
  var container = document.getElementById('tts-avatar');
  var closeBtn  = document.getElementById('av-close');
  if (!wrap || !container) return;

  // ── Lottie setup ──────────────────────────────────────────────────
  var anim      = null;
  var animReady = false;
  var wantPlay  = false; // play requested before anim loaded

  function initLottie() {
    if (anim) return;
    anim = lottie.loadAnimation({
      container: container,
      renderer:  'svg',
      loop:      true,
      autoplay:  false,
      path:      '/lottie-avatar.json',
    });
    anim.addEventListener('DOMLoaded', function() {
      animReady = true;
      if (wantPlay) { anim.play(); wantPlay = false; }
    });
  }

  function startAnim() {
    if (!animReady) { wantPlay = true; initLottie(); return; }
    anim.play();
  }

  function stopAnim() {
    wantPlay = false;
    if (!animReady || !anim) return;
    anim.stop(); // goes back to frame 0 — bars flat
  }

  // ── Show / Hide ───────────────────────────────────────────────────
  function showAvatar() {
    var _avPref = document.getElementById('p-avatar');
    if (_avPref && !_avPref.checked) return;
    initLottie();
    wrap.style.display = 'block';
    if (closeBtn) closeBtn.style.display = 'block';
    startAnim();
  }

  function hideAvatar() {
    stopAnim();
    wrap.style.display = 'none';
    if (closeBtn) closeBtn.style.display = 'none';
  }

  window._avClose = hideAvatar;

  // ── Drag to move (no float) ───────────────────────────────────────
  var dragging     = false;
  var dragOffX     = 0;
  var dragOffY     = 0;
  var dragAnchored = true;

  function toAbsolute() {
    if (!dragAnchored) return;
    var rect = wrap.getBoundingClientRect();
    wrap.style.transform = 'none';
    wrap.style.top    = rect.top  + 'px';
    wrap.style.left   = rect.left + 'px';
    wrap.style.bottom = 'auto';
    dragAnchored = false;
  }

  function onDragStart(clientX, clientY) {
    if (closeBtn && closeBtn.contains(document.elementFromPoint(clientX, clientY))) return;
    toAbsolute();
    dragging = true;
    var rect = wrap.getBoundingClientRect();
    dragOffX = clientX - rect.left;
    dragOffY = clientY - rect.top;
    wrap.classList.add('dragging');
    wrap.classList.remove('draggable');
  }

  function onDragMove(clientX, clientY) {
    if (!dragging) return;
    var newLeft = clientX - dragOffX;
    var newTop  = clientY - dragOffY;
    var maxLeft = window.innerWidth  - wrap.offsetWidth  - 10;
    var maxTop  = window.innerHeight - wrap.offsetHeight - 10;
    newLeft = Math.max(10, Math.min(newLeft, maxLeft));
    newTop  = Math.max(10, Math.min(newTop,  maxTop));
    wrap.style.left = newLeft + 'px';
    wrap.style.top  = newTop  + 'px';
  }

  function onDragEnd() {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    wrap.classList.add('draggable');
  }

  wrap.addEventListener('mousedown', function(e) { onDragStart(e.clientX, e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', function(e) { onDragMove(e.clientX, e.clientY); });
  document.addEventListener('mouseup', function() { onDragEnd(); });
  wrap.addEventListener('touchstart', function(e) { var t=e.touches[0]; onDragStart(t.clientX,t.clientY); }, { passive: true });
  document.addEventListener('touchmove', function(e) { if(!dragging) return; var t=e.touches[0]; onDragMove(t.clientX,t.clientY); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchend', function() { onDragEnd(); });
  wrap.classList.add('draggable');

  // ── Kokoro path — hook the audio element ─────────────────────────
  function hookPlayer(el) {
    if (el._avHooked) return;
    el._avHooked = true;
    el.addEventListener('play',  function(){ showAvatar(); });
    el.addEventListener('pause', function(){ hideAvatar(); });
    el.addEventListener('ended', function(){ hideAvatar(); });
  }

  var existing = document.getElementById('_kplayer');
  if (existing) hookPlayer(existing);

  new MutationObserver(function(muts) {
    for (var i = 0; i < muts.length; i++) {
      var nodes = muts[i].addedNodes;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].id === '_kplayer') hookPlayer(nodes[j]);
      }
    }
  }).observe(document.body, { childList: true });

  // ── ElevenLabs path — SSE tts_start / tts_end events ─────────────
  (function(){
    var sp2   = new URLSearchParams(window.location.search);
    var tok2  = sp2.get('token') || sp2.get('t') || '';
    var authQ2 = tok2 ? ('?' + (sp2.get('token') ? 'token' : 't') + '=' + encodeURIComponent(tok2)) : '';
    var elTimer = null;
    try {
      var es2 = new EventSource('/api/stream' + authQ2);

      es2.addEventListener('tts_start', function(e) {
        try {
          var d = JSON.parse(e.data);
          if (d.engine === 'elevenlabs') {
            clearTimeout(elTimer);
            showAvatar();
            // Fallback stop: use estimatedMs if provided, else 30s safety cap
            var ms = (d.estimatedMs && d.estimatedMs > 0) ? d.estimatedMs : 30000;
            elTimer = setTimeout(hideAvatar, ms);
          }
        } catch(ex) {}
      });

      // tts_end fired by server when ElevenLabs speak() resolves
      es2.addEventListener('tts_end', function(e) {
        try {
          var d = JSON.parse(e.data);
          if (d.engine === 'elevenlabs') {
            clearTimeout(elTimer);
            hideAvatar();
          }
        } catch(ex) {}
      });

      // Hide if a new AI processing cycle starts (user sent another prompt)
      es2.addEventListener('state', function(e) {
        try {
          var d = JSON.parse(e.data);
          if (d.processing === true && wrap.style.display === 'block') {
            clearTimeout(elTimer);
            hideAvatar();
          }
        } catch(ex) {}
      });
    } catch(ex) {}
  })();

})();
</script>
</body>
</html>`;
}

// Served when the meta-refresh URL token has expired (after ~3hr session).
// Stops the 401 flood in logs and gives the user a clear message.
const EXPIRED_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Session Expired — GeauxAiPrompt</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#0f0d1a;color:#e2e8f0;font-family:system-ui,sans-serif;
  min-height:100%;display:flex;align-items:center;justify-content:center;
  text-align:center;padding:32px}
.wrap{max-width:300px}
.icon{font-size:40px;margin-bottom:16px}
h2{font-size:17px;color:#a78bfa;margin-bottom:10px;font-family:monospace;letter-spacing:.05em}
p{font-size:13px;color:#6b7280;line-height:1.65}
</style>
</head>
<body><audio id="_kplayer" style="display:none" preload="auto"></audio>
<div class="wrap">
  <div class="icon">🔄</div>
  <h2>SESSION EXPIRED</h2>
  <p>Your webview session link has expired.<br><br>
  Reopen <strong style="color:#e2e8f0">GeauxAiPrompt</strong> from the<br>
  Mentra app to get a fresh link.</p>
</div>
</body>
</html>`;

// ── App ───────────────────────────────────────────────────────────────────────
class GeauxAIApp extends AppServer {

  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    console.log(`[Session] Connected: ${userId}`);

    // Enable dashboard with always-on overlay
    try {
      await session.dashboard.mode.set({ enabled: true, alwaysOn: true });
    } catch {}

    activeSessions.set(userId, session);

    // Restore persisted preferences (TTS, mic, genParams) from previous session
    await loadUserPrefs(session, userId);

    // Initialize dashboard — show Ready state with model info
    updateDashboard(session, 'Ready', undefined, getState(userId).history.length);
    // Expanded dashboard: shown when user looks up — static usage hint
    try {
      await (session.dashboard.content as any).writeToExpanded(
        'GeauxAiPrompt v2\nSay "Go AI" + your question\nOr type on phone'
      );
    } catch {}

    // ── Suppress known harmless SDK noise ─────────────────────────────────────
    // The G1 glasses send "device_state_update" messages that the current SDK
    // version doesn't recognize yet. This causes a thrown Error that the SDK's
    // internal error handler catches and logs as ERROR. We intercept it here so
    // it doesn't flood the console while the SDK team adds support.
    // Everything works fine — this is purely cosmetic log suppression.
    const origEmit = (session as any).emit?.bind(session);
    if (origEmit) {
      (session as any).emit = (event: string, ...args: any[]) => {
        if (event === 'error' && args[0]?.message?.includes('device_state_update')) {
          // Silently ignore — known unhandled message type from G1 firmware
          return false;
        }
        return origEmit(event, ...args);
      };
    }

    try { await session.layouts.showTextWall('GeauxAI ready\n\nSay "Go AI" then speak\nChat log on your phone'); } catch {}

    // ── Button handler ────────────────────────────────────────────────────────
    // G1 has two TouchBars (left temple / right temple).
    // MentraOS SDK fires onButtonPress with data = { pressType, buttonId, ... }
    //
    // buttonId values observed on G1 via MentraOS:
    //   "right"  — right TouchBar tap
    //   "left"   — left TouchBar tap
    //   "main"   — some SDK versions use this for either/both bars
    //
    // We log the full raw payload on every press so you can verify exactly what
    // your hardware sends — check the server console output after pressing each bar.
    //
    // Navigation mapping:
    //   Right short tap  → next page  (forward)
    //   Left  short tap  → prev page  (back)
    //   Either long press → clear history (existing behaviour preserved)
    //
    // Fallback if buttonId doesn't distinguish sides (older SDK / firmware):
    //   Short tap → next page (cycles forward through all pages)
    //   Long press → clear history
    session.events.onButtonPress(async (data: any) => {
      const pressType: string  = data.pressType  || '';
      const buttonId:  string  = data.buttonId   || '';
      // Log everything so you can confirm exact field names your G1 sends
      console.log(`[Button] pressType="${pressType}" buttonId="${buttonId}" raw=${JSON.stringify(data)}`);

      const s = getState(userId);

      // Any button press cancels both auto-clear timers
      cancelAutoClearTimer(userId);
      cancelStatusClearTimer(userId);

      // Long press on either side = clear history
      if (pressType === 'long' || pressType === 'long_press') {
        s.history     = [];
        s.lastResponse = '';
        s.pages       = [];
        s.pageIndex   = 0;
        console.log(`[Button] Long press — history cleared for ${userId}`);
        await showStatusOnGlasses(session, userId, 'History cleared.\nReady for new prompts.');
        updateDashboard(session, 'Ready', 'History cleared', 0);
        return;
      }

      // Short press — navigate pages if we have a multi-page response
      if (pressType === 'short' || pressType === '') {
        if (s.pages.length === 0) {
          // No paginated response stored yet — replay last response if available
          if (s.lastResponse) {
            console.log(`[Button] Short press, no pages — replaying last response`);
            try { await showOnGlasses(session, s.lastResponse); } catch {}
          }
          return;
        }

        // Determine direction: right=forward, left=back, unknown=forward
        const isLeft  = buttonId === 'left';

        let newIndex = s.pageIndex;
        if (isLeft) {
          // Previous page — clamp at 0
          newIndex = Math.max(0, s.pageIndex - 1);
        } else {
          // Next page (right or unknown) — clamp at last page
          newIndex = Math.min(s.pages.length - 1, s.pageIndex + 1);
        }

        if (newIndex === s.pageIndex && isLeft  && s.pageIndex === 0) {
          console.log(`[Button] Already at first page`);
          try { await session.layouts.showTextWall(`[1/${s.pages.length}]\n${s.pages[0]}`); } catch {}
          return;
        }
        if (newIndex === s.pageIndex && !isLeft && s.pageIndex === s.pages.length - 1) {
          console.log(`[Button] Already at last page`);
          try { await session.layouts.showTextWall(`[${s.pages.length}/${s.pages.length}]\n${s.pages[s.pageIndex]}`); } catch {}
          return;
        }

        s.pageIndex = newIndex;
        console.log(`[Button] ${isLeft ? 'LEFT←prev' : 'RIGHT→next'} → page ${s.pageIndex + 1}/${s.pages.length}`);
        try { await session.layouts.showTextWall(`[${s.pageIndex + 1}/${s.pages.length}]\n${s.pages[s.pageIndex]}`); } catch {}
      }
    });

    // Transcription: always-on mic, gated by wake word
    session.events.onTranscription(async (data: any) => {
      const s2 = getState(userId);
      if (s2.micMuted) return;  // mic toggled off from webview
      const transcript = data.text?.trim() || '';
      if (!data.isFinal) {
        // Interim result — show voice activity indicator
        if (transcript.length >= 3) {
          s2.isListening = true;
          broadcastToUser(userId, 'listening', { active: true, partial: transcript.trim() });
        }
        return;
      }
      // Final result
      s2.isListening = false;
      broadcastToUser(userId, 'listening', { active: false, partial: '' });
      const text = transcript;
      if (!text || text.length < 3) return;
      // Wake word check — voice-only; typed /prompt bypasses this entirely
      if (!text.toLowerCase().startsWith(WAKE_WORD)) return;
      const stripped = text.slice(WAKE_WORD.length).replace(/^[,\s]+/, '').trim();
      if (!stripped) return;
      console.log(`[WakeWord] Triggered: "${stripped}"`);
      await handlePrompt(userId, stripped, session);
    });

    console.log('[Events] transcription, button_press registered');

    // Device state polling — SDK does not expose onDeviceStateChange; instead
    // we poll session.device every 30 s and broadcast when values change.
    const devicePollInterval = setInterval(() => {
      try {
        const dev = session?.device;
        if (!dev) return;
        const snap = {
          batteryLevel:  dev.batteryLevel  ?? null,
          charging:      dev.charging      ?? false,
          wifiConnected: dev.wifiConnected ?? false,
        };
        const current = getState(userId).deviceState;
        if (!current ||
            current.batteryLevel  !== snap.batteryLevel  ||
            current.charging      !== snap.charging      ||
            current.wifiConnected !== snap.wifiConnected) {
          getState(userId).deviceState = snap;
          broadcastToUser(userId, 'device', snap);
        }
      } catch {}
    }, 30000);
    devicePollIntervals.set(userId, devicePollInterval);
  }

  // ── Mira AI Tool Integration ───────────────────────────────────────────────
  // Tools registered in MentraOS Developer Console (console.mentra.glass):
  //   ask_geauxai : { question: string } — Ask GeauxAI a question via Mira
  //   web_search  : { query:    string } — Search the web via Tavily
  // Tool calls arrive outside active sessions; they use this server-level hook.
  protected async onToolCall(toolCall: any): Promise<string | undefined> {
    console.log(`[ToolCall] ${toolCall.toolId} from ${toolCall.userId}`);
    try {
      if (toolCall.toolId === 'ask_geauxai') {
        const question = toolCall.toolParameters?.question as string;
        if (!question) return 'Please provide a question.';

        // One-shot AI call — no conversation history for tool calls
        const userHistory = [{ role: 'user', content: question }];
        const params      = getState(toolCall.userId).genParams;
        const response    = await callAI(userHistory, params);
        const clean       = stripMarkdown(response);
        console.log(`[ToolCall] Response: "${clean.substring(0, 80)}"`);

        // If user has an active glasses session, also display the answer there
        const activeSession = activeSessions.get(toolCall.userId);
        if (activeSession) {
          const s = getState(toolCall.userId);
          s.lastPrompt = truncate(question, 40);
          await showOnGlasses(activeSession, clean, toolCall.userId);
        }
        return clean;
      }

      if (toolCall.toolId === 'web_search') {
        const query = toolCall.toolParameters?.query as string;
        if (!query) return 'Please provide a search query.';
        const results = await webSearch(query);
        return results || 'No results found.';
      }

      return undefined; // Unknown tool — let MentraOS handle it
    } catch (err: any) {
      console.error(`[ToolCall] Error: ${err.message}`);
      return `Error: ${err.message}`;
    }
  }

  protected async onStop(sessionId: string, userId: string, reason: string) {
    console.log(`[Session] Stopped: ${userId} (${reason})`);
    activeSessions.delete(userId);
    const pollInterval = devicePollIntervals.get(userId);
    if (pollInterval !== undefined) {
      clearInterval(pollInterval);
      devicePollIntervals.delete(userId);
    }
  }

  public addRoutes() {
    const app = this.getExpressApp();

    // Place assets/MainLogo.png in your project root (same dir as src/)
    // The logo is served at GET /logo.png
    app.get('/logo.png', async (_req: any, res: any) => {
      try {
        const file = Bun.file('assets/MainLogo.png');
        const buf  = await file.arrayBuffer();
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(Buffer.from(buf));
      } catch {
        res.status(404).end('Logo not found');
      }
    });

    // Required: parse urlencoded form bodies (textarea POST sends text=... urlencoded)
    // The MentraOS SDK sets up JSON body parsing but NOT urlencoded — we add both here.
    app.use(require('express').urlencoded({ extended: false, limit: '1mb' }));
    app.use(require('express').json({ limit: '25mb' }));

    app.use('/lottie-avatar.json', (_req: any, res: any) => {
      res.sendFile(require('path').join(__dirname, 'voice.json'));
    });

    // ── Per-request user resolver ─────────────────────────────────────────────
    // The SDK auth middleware sets req.authUserId from the signed token on every
    // request. We use that so each user sees their OWN conversation and state.
    // Falls back to OWNER_EMAIL only when the webview is opened without a signed
    // token (e.g. direct browser hit during local dev) so the owner's dev workflow
    // is unchanged.
    // resolveUser returns the authenticated userId, or null if not authenticated.
    // OWNER_EMAIL fallback is only used in local dev (NODE_ENV !== 'production').
    // In production, unauthenticated requests get null and are rejected by their handlers.
    // DEPLOYMENT NOTE: Set NODE_ENV=production in your Oracle .env to enable the strict
    // auth check. On GMKtec local dev, either leave NODE_ENV unset or set it to
    // 'development' and keep OWNER_EMAIL set — the fallback still works locally.
    const resolveUser = (req: any): string | null => {
      // Priority 1: MentraOS SDK-verified token (glasses app / signed webview URL)
      if (req.authUserId) return req.authUserId;
      // Priority 2: Cloudflare Access OTP-verified email header.
      // Cloudflare injects this after a user passes email OTP — it cannot be
      // spoofed by clients because Cloudflare strips any client-sent Cf-Access-*
      // headers before forwarding to the origin. Every browser user who passes
      // Cloudflare OTP gets their own completely isolated session, history, and state.
      const cfEmail = req.headers?.['cf-access-authenticated-user-email'];
      if (cfEmail && typeof cfEmail === 'string' && cfEmail.includes('@')) {
        return cfEmail.toLowerCase().trim();
      }
      // Priority 3: Local dev fallback — disabled in production
      if (process.env.NODE_ENV !== 'production' && OWNER_EMAIL) return OWNER_EMAIL;
      return null;
    };

    // Serve the live chat page.
    // The SDK auth middleware runs on every request and sets req.authUserId when token is valid.
    // When the meta-refresh signed URL token expires (~3hr), it logs "Signed user token invalid"
    // but still calls next() — our handler runs. We detect expiry via req.authUserId being
    // absent AND a query parameter the SDK injects for signed URLs. Simplest safe check:
    // if the request has a 'token' or 't' query param (signed URL) but authUserId is missing,
    // the token has expired. Serve a friendly page instead of rendering stale history silently.
    const serve = (req: any, res: any) => {
      const hasSignedToken = req.query?.token || req.query?.t;
      const authFailed = hasSignedToken && !req.authUserId;
      if (authFailed) {
        console.log('[Webview] Signed token expired — serving expired-session page');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(401).end(EXPIRED_PAGE_HTML);
      }
      const userId = resolveUser(req);
      if (!userId) {
        console.log('[Webview] No auth token — rejecting unauthenticated request');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(401).end(EXPIRED_PAGE_HTML);
      }
      const s = getState(userId);
      const html = buildPage(
        activeSessions.has(userId),
        s.isProcessing,
        s.history,
        s.micMuted,
        s.ttsEnabled,
        s.ttsEngine,
        Math.floor(s.history.length / 2)
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    };

    // POST /clear — "New Chat" button submits this form.
    // Clears server-side history, notifies glasses if connected,
    // then redirects back so the browser reloads a fresh empty page.
    app.post('/clear', async (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) return res.redirect(303, '/webview');
      cancelAutoClearTimer(userId);
      const s = getState(userId);
      s.history = [];
      s.lastResponse = '';
      s.pages = [];
      s.pageIndex = 0;
      console.log(`[WebClear] History cleared for ${userId}`);
      broadcastToUser(userId, 'state', { processing: false, searching: false, micMuted: s.micMuted, ttsEnabled: s.ttsEnabled, ttsEngine: s.ttsEngine, connected: activeSessions.has(userId), reload: true });
      const session = activeSessions.get(userId);
      if (session) {
        await showStatusOnGlasses(session, userId, 'History cleared.\nReady for new prompts.');
        updateDashboard(session, 'Ready', 'History cleared', 0);
      }
      res.redirect(303, '/webview');
    });

    app.post('/mic', async (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) return res.redirect(303, '/webview');
      cancelAutoClearTimer(userId);
      const s = getState(userId);
      s.micMuted = !s.micMuted;
      console.log(`[MicToggle] ${userId} micMuted=${s.micMuted}`);
      broadcastToUser(userId, 'state', { processing: s.isProcessing, searching: false, micMuted: s.micMuted, ttsEnabled: s.ttsEnabled, ttsEngine: s.ttsEngine, connected: activeSessions.has(userId), reload: false });
      const session = activeSessions.get(userId);
      if (session) {
        updateDashboard(session, s.micMuted ? 'Mic Off' : 'Listening');
        const msg = s.micMuted ? 'Microphone muted.\nTap MIC ON in the app to resume.' : 'Microphone active.\nSpeak into your glasses.';
        await showStatusOnGlasses(session, userId, msg);
        saveUserPrefs(session, userId).catch(() => {});
      }
      res.redirect(303, '/webview');
    });

    app.post('/tts', async (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) return res.json({ ok: false, error: 'Unauthorized' });
      const s = getState(userId);
      s.ttsEnabled = !s.ttsEnabled;
      console.log(`[TTSToggle] ${userId} ttsEnabled=${s.ttsEnabled}`);
      broadcastToUser(userId, 'state', {
        processing: s.isProcessing, searching: false,
        micMuted: s.micMuted, ttsEnabled: s.ttsEnabled, ttsEngine: s.ttsEngine,
        connected: activeSessions.has(userId), reload: false,
      });
      const activeSession = activeSessions.get(userId);
      if (activeSession) saveUserPrefs(activeSession, userId).catch(() => {});
      res.json({ ok: true, ttsEnabled: s.ttsEnabled });
    });

    app.post('/tts-engine', async (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) return res.json({ ok: false, error: 'Unauthorized' });
      const s = getState(userId);
      if (s.ttsEngine === 'kokoro') {
        s.ttsEngine = ELEVENLABS_API_KEY ? 'elevenlabs' : 'kokoro';
      } else if (s.ttsEngine === 'elevenlabs') {
        s.ttsEngine = ELEVENLABS_API_KEY ? 'elevenlabs_direct' : 'kokoro';
      } else {
        s.ttsEngine = 'kokoro';
      }
      console.log(`[TTSEngine] ${userId} ttsEngine=${s.ttsEngine}`);
      broadcastToUser(userId, 'state', {
        processing: s.isProcessing, searching: false,
        micMuted: s.micMuted, ttsEnabled: s.ttsEnabled, ttsEngine: s.ttsEngine,
        connected: activeSessions.has(userId), reload: false,
      });
      const activeSession = activeSessions.get(userId);
      if (activeSession) saveUserPrefs(activeSession, userId).catch(() => {});
      res.json({ ok: true, ttsEngine: s.ttsEngine });
    });

    app.post('/prompt', async (req: any, res: any) => {
      const text = req.body?.text?.trim();
      if (!text || text.length < 1) return res.redirect(303, '/webview');
      const userId = resolveUser(req);
      if (!userId) return res.redirect(303, '/webview');
      const session = activeSessions.get(userId);
      if (!session) {
        console.log(`[TypePrompt] No active glasses session for ${userId} — processing as web-only`);
      }
      const s = getState(userId);
      // -- Per-user rate limiting --------------------------------------------
      const now = Date.now();
      const rl = rateLimits.get(userId) ?? { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
      if (now > rl.resetTime) { rl.count = 0; rl.resetTime = now + RATE_LIMIT_WINDOW_MS; }
      if (rl.count >= RATE_LIMIT_MAX_REQUESTS) {
        console.log(`[RateLimit] ${userId} hit limit`);
        rateLimits.set(userId, rl);
        return res.status(429).json({ error: 'Rate limit exceeded. Try again in 60s.' });
      }
      rl.count++;
      rateLimits.set(userId, rl);
      if (s.isProcessing) {
        console.log('[TypePrompt] Already processing — ignored');
        return res.redirect(303, '/webview');
      }
      console.log(`[TypePrompt] ${userId} "${text.substring(0, 60)}"`);
      getState(userId).pendingRefresh = true;
      handlePrompt(userId, text, session as AppSession);     // fire-and-forget
      res.redirect(303, '/webview');
    });

    // ── File/Image/Audio upload route ─────────────────────────────────────────
    app.post('/upload', upload.single('file'), async (req: any, res: any) => {
      const userId = resolveUser(req);
      const session = activeSessions.get(userId);
      if (!session) {
        console.log(`[Upload] No active glasses session for ${userId} — processing as web-only`);
      }

      const text = (req.body?.text || '').trim();
      const file = req.file; // multer puts the file here

      // Rate limit check (same logic as /prompt)
      const now = Date.now();
      const rl = rateLimits.get(userId) ?? { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
      if (now > rl.resetTime) { rl.count = 0; rl.resetTime = now + RATE_LIMIT_WINDOW_MS; }
      if (rl.count >= RATE_LIMIT_MAX_REQUESTS) {
        rateLimits.set(userId, rl);
        return res.status(429).json({ error: 'Rate limit exceeded. Try again in 60s.' });
      }
      rl.count++;
      rateLimits.set(userId, rl);

      const s = getState(userId);
      if (s.isProcessing) {
        return res.status(429).json({ error: 'Already processing a prompt. Please wait.' });
      }

      // If no file, fall through to normal text prompt
      if (!file) {
        if (!text) return res.status(400).json({ error: 'No text or file provided.' });
        handlePrompt(userId, text, session);
        return res.json({ ok: true });
      }

      // Determine file category
      const mime = file.mimetype || '';
      const filename = file.originalname || 'file';
      const isImage = mime.startsWith('image/');
      const isAudio = mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|webm)$/i.test(filename);
      const isDoc   = mime === 'application/pdf' || mime === 'text/plain' || /\.(pdf|txt)$/i.test(filename);

      console.log(`[Upload] ${userId} file="${filename}" mime="${mime}" size=${file.size}`);

      try {
        if (isImage) {
          const base64 = file.buffer.toString('base64');
          const mediaType = mime || 'image/jpeg';
          const promptText = text || 'Describe this image in detail.';
          await handleImagePrompt(userId, promptText, base64, mediaType, session);
          return res.json({ ok: true });
        }

        if (isAudio) {
          if (AI_PROVIDER !== 'openai' || !OPENAI_KEY) {
            return res.status(400).json({ error: 'Audio transcription requires OpenAI provider with OPENAI_API_KEY set.' });
          }
          const transcript = await transcribeAudio(file.buffer, filename, mime);
          if (!transcript) {
            return res.status(500).json({ error: 'Audio transcription failed.' });
          }
          const combined = text
            ? `[Audio transcript]: ${transcript}\n\n${text}`
            : `[Audio transcript]: ${transcript}`;
          handlePrompt(userId, combined, session);
          return res.json({ ok: true, transcript });
        }

        if (isDoc) {
          let docText = '';
          if (mime === 'text/plain' || /\.txt$/i.test(filename)) {
            docText = file.buffer.toString('utf-8');
          } else {
            try {
              const pdfParse = require('pdf-parse');
              const pdfData = await pdfParse(file.buffer);
              docText = pdfData.text || '';
            } catch (err: any) {
              console.log(`[Upload] PDF parse failed: ${err.message}`);
              return res.status(500).json({ error: 'Could not extract text from PDF.' });
            }
          }
          docText = docText.slice(0, 8000); // cap context
          const combined = text
            ? `[Document content]:\n${docText}\n\n${text}`
            : `[Document content]:\n${docText}\n\nPlease summarize and analyze this document.`;
          handlePrompt(userId, combined, session);
          return res.json({ ok: true });
        }

        return res.status(400).json({ error: `Unsupported file type: ${mime}` });

      } catch (err: any) {
        console.error(`[Upload] Error: ${err.message}`);
        return res.status(500).json({ error: err.message });
      }
    });

    // ── SSE real-time push ────────────────────────────────────────────────────
    // GET /api/stream — client subscribes here; server pushes 'state' events
    app.get('/api/stream', (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) {
        console.log('[SSE] No auth token — rejecting unauthenticated stream request');
        return res.status(401).end('');
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const s = getState(userId);
      s.sseClients.push(res);

      // Send current state immediately so client doesn't wait for the first change
      const initData = JSON.stringify({
        processing: s.isProcessing, searching: false,
        micMuted: s.micMuted, ttsEnabled: s.ttsEnabled, ttsEngine: s.ttsEngine,
        connected: activeSessions.has(userId), reload: false,
      });
      res.write(`event: state\ndata: ${initData}\n\n`);

      // Send initial device snapshot immediately (battery / charging / wifi)
      try {
        const dev = activeSessions.get(userId)?.device;
        const deviceSnap = {
          batteryLevel:  dev?.batteryLevel  ?? null,
          charging:      dev?.charging      ?? false,
          wifiConnected: dev?.wifiConnected ?? false,
        };
        s.deviceState = deviceSnap;
        broadcastToUser(userId, 'device', deviceSnap);
      } catch {
        // device state not available yet, client will show ⚠️
      }

      const keepalive = setInterval(() => {
        try { res.write('event: keepalive\ndata: {}\n\n'); } catch { clearInterval(keepalive); }
      }, 10000);

      req.on('close', () => {
        clearInterval(keepalive);
        const s2 = userStates.get(userId);
        if (s2) s2.sseClients = s2.sseClients.filter(c => c !== res);
      });
    });

    // ── Generation params API ─────────────────────────────────────────────────
    // GET  /api/params — return current per-user gen params as JSON
    // POST /api/params — update per-user gen params (called from webview JS)
    app.get('/api/params', (req: any, res: any) => {
      const userId = resolveUser(req);
      res.json(getState(userId).genParams);
    });

    app.post('/api/params', async (req: any, res: any) => {
      const userId = resolveUser(req);
      const s = getState(userId);
      const b = req.body || {};
      if (typeof b.systemPrompt === 'string')
        s.genParams.systemPrompt = b.systemPrompt.slice(0, 2000);
      if (typeof b.temperature === 'number')
        s.genParams.temperature  = Math.min(2, Math.max(0, b.temperature));
      if (typeof b.topP === 'number')
        s.genParams.topP         = Math.min(1, Math.max(0, b.topP));
      if (typeof b.maxTokens === 'number')
        s.genParams.maxTokens    = Math.min(32000, Math.max(256, Math.round(b.maxTokens)));
      if (typeof b.model === 'string')
        s.genParams.model        = b.model.slice(0, 200);
      if (typeof b.webSearch === 'boolean')
        s.genParams.webSearch    = b.webSearch;
      if (typeof b.useCloudflare === 'boolean')
        s.genParams.useCloudflare = b.useCloudflare;
      if (typeof b.elevenLabsVoiceId === 'string')
        s.genParams.elevenLabsVoiceId = b.elevenLabsVoiceId;
      if (typeof b.elevenDirectVoiceId === 'string')
        s.genParams.elevenDirectVoiceId = b.elevenDirectVoiceId;
      if (b.elevenPathPref === 'mentraos' || b.elevenPathPref === 'geauxai')
        s.genParams.elevenPathPref = b.elevenPathPref;
      // Sync ttsEngine with elevenPathPref when ELEVEN is active
      if (s.ttsEngine === 'elevenlabs' || s.ttsEngine === 'elevenlabs_direct') {
        s.ttsEngine = s.genParams.elevenPathPref === 'geauxai' ? 'elevenlabs_direct' : 'elevenlabs';
      }
      if (typeof b.kokoroVoice === 'string')
        s.genParams.kokoroVoice = b.kokoroVoice;
      if (typeof b.avatarEnabled === 'boolean')
        s.genParams.avatarEnabled = b.avatarEnabled;
      if (typeof b.browserMicEnabled === 'boolean')
        s.genParams.browserMicEnabled = b.browserMicEnabled;
      console.log(`[Params] ${userId} temp=${s.genParams.temperature} topP=${s.genParams.topP} maxTok=${s.genParams.maxTokens} model="${s.genParams.model||'(default)'}" webSearch=${s.genParams.webSearch} cf=${s.genParams.useCloudflare} sys="${s.genParams.systemPrompt.slice(0,40)}"`);
      const sess = activeSessions.get(userId);
      if (sess) {
        updateDashboard(sess, 'Ready', undefined, s.history.length);
        saveUserPrefs(sess, userId).catch(() => {});
      }
      res.json({ ok: true });
    });

    // ── Models API ────────────────────────────────────────────────────────────
    // GET /api/models — no auth required; read-only metadata
    // Returns locally available Ollama model names + the server default model.
    // Pass ?provider=cloudflare to get the Cloudflare model catalog instead.
    app.get('/api/models', async (req: any, res: any) => {
      const provider = req.query?.provider;
      if (provider === 'cloudflare') {
        return res.json({ models: CF_MODELS, default: CF_MODELS[0] });
      }
      // Default: Ollama local models
      try {
        const r = await fetch(`${OLLAMA_HOST}/api/tags`);
        if (!r.ok) throw new Error(`Ollama tags error ${r.status}`);
        const data = (await r.json()) as any;
        const models: string[] = (data.models || []).map((m: any) => m.name as string);
        res.json({ models, default: AI_MODEL });
      } catch {
        res.json({ models: [], default: AI_MODEL });
      }
    });

    // GET /api/kokoro-voices — fetches available voices from local Kokoro instance
    app.get('/api/kokoro-voices', async (_req: any, res: any) => {
      try {
        const r = await fetch(`${KOKORO_HOST}/v1/audio/voices`);
        if (!r.ok) throw new Error(`Kokoro voices error ${r.status}`);
        const data = (await r.json()) as any;
        // Kokoro returns { voices: ["af_bella", "af_sky", ...] }
        const voices: string[] = Array.isArray(data.voices) ? data.voices : [];
        res.json({ voices });
      } catch {
        // Return empty list if Kokoro is not running or unreachable
        res.json({ voices: [] });
      }
    });

    // GET /api/elevenlabs-voices-free — ElevenLabs premade/default voices, available on free tier via direct API
    app.get('/api/elevenlabs-voices-free', (_req: any, res: any) => {
      res.json({ voices: [
        { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Female, American)' },
        { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (Male, American, Deep)' },
        { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice (Female, British)' },
        { voice_id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill (Male, American)' },
        { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie (Male, Australian)' },
        { voice_id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte (Female, Swedish)' },
        { voice_id: 'iP95p4xoKVk53GoZ742B', name: 'Chris (Male, American)' },
        { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel (Male, British, Authoritative)' },
        { voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric (Male, American)' },
        { voice_id: 'jsCqWAovK2LkecY7zXl4', name: 'Freya (Female, American)' },
        { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George (Male, British)' },
        { voice_id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam (Male, American)' },
        { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda (Female, American, Warm)' },
        { voice_id: 'SAz9YHcvj6GT2YYXdXww', name: 'River (Neutral, American)' },
        { voice_id: 'bIHbv24MWmeRgasZH58o', name: 'Will (Male, American, Friendly)' },
      ]});
    });

    // GET /api/elevenlabs-voices — returns static hardcoded voice list (MentraOS path — Mentra's ElevenLabs account)
    app.get('/api/elevenlabs-voices', (_req: any, res: any) => {
      res.json({ voices: [
        // ── YOUR CUSTOM VOICE LIBRARY VOICES (keep all originals) ──
        { voice_id: 'ZzBpNW0j7Iq2XRx6Xo49', name: 'Indian' },
        { voice_id: '7QwDAfHpHjPD14XYTSiq', name: 'Asian' },
        { voice_id: '0QT4OrDTvpDlUPmFsUWN', name: 'Lily Ausie' },
        { voice_id: 'V0PuVTP8lJVnkKNavZmc', name: 'Nigerian' },
        { voice_id: 'mKoqwDP2laxTdq1gEgU6', name: 'Casey Kasem' },
        { voice_id: 'DLsHlh26Ugcm6ELvS0qi', name: 'Southern' },
        { voice_id: '1KFdM0QCwQn4rmn5nn9C', name: 'Parasyte' },
        { voice_id: 'xsiB5fGhEtknnqzudCO6', name: 'Smoke The Dragon' },
        { voice_id: 'ouL9IsyrSnUkCmfnD02u', name: 'Grimblewood' },
        { voice_id: 'JzB4cRKwI655namyRezF', name: 'Thorn' },
        { voice_id: 'HIGUfNOdjuWQwwapnTRW', name: 'Chuck Miller' },
        { voice_id: 'hA4zGnmTwX2NQiTRMt7o', name: 'Riley' },
        { voice_id: 'n7Wi4g1bhpw4Bs8HK5ph', name: 'Gigi (Library)' },
        { voice_id: 'xzZRXG86mSM3naOyL9fa', name: 'Rowan' },
        { voice_id: 'ZTLBC2emTrxYTdCF99Kb', name: 'Rozie' },
        { voice_id: '3YMJvGH8HlrOcHJkHNKl', name: 'Amaya' },
        { voice_id: 'J8f1H4cMZ1c0AfhHGMag', name: 'Pocholo' },
        { voice_id: 'EVHfImLeQUjQG40OZl3q', name: 'Juan' },
        { voice_id: 'wNl2YBRc8v5uIcq6gOxd', name: 'Kuya' },
        { voice_id: 'bY54gWrN4O4G9QOFtXwl', name: 'Inday' },
        { voice_id: 'b8XX4QShLFkd3yZQlz8T', name: 'Ify' },
        { voice_id: 'oC2pCZZWEDRe6lmZpaaw', name: 'Bukola' },
        { voice_id: 'yp4MmTRKvE7VXY3hUJRY', name: 'Timi' },
        { voice_id: 'V2D1qkaFj5NormT9yoaK', name: 'Hoyeen' },
        { voice_id: 'TBvIh5TNCMX6pQNIcWV8', name: 'Chidiebere' },
        // ── NEW DEFAULT VOICES (permanent, recommended) ──
        { voice_id: '9BWtsMINqrJLrRacOk9x', name: 'Aria (Female, American, Expressive)' },
        { voice_id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger (Male, American, Confident)' },
        { voice_id: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura (Female, American, Upbeat)' },
        { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica (Female, American, Conversational)' },
        { voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric (Male, American, Friendly)' },
        { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George (Male, British, Warm)' },
        { voice_id: 'SAz9YHcvj6GT2YYXdXww', name: 'River (Non-binary, American, Confident)' },
        { voice_id: 'bIHbv24MWmeRgasZH58o', name: 'Will (Male, American, Friendly)' },
        { voice_id: 'nPczCjzI2devNBz1zQrb', name: 'Brian (Male, American, Deep)' },
        { voice_id: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum (Male, Transatlantic, Intense)' },
        { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie (Male, Australian, Casual)' },
        { voice_id: 'XB0fDUnXU5powFXDhCwa', name: 'Charlotte (Female, Swedish, Seductive)' },
        { voice_id: 'iP95p4xoKVk53GoZ742B', name: 'Chris (Male, American, Casual)' },
        { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel (Male, British, Authoritative)' },
        { voice_id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam (Male, American, Articulate)' },
        { voice_id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily (Female, British, Warm)' },
        { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda (Female, American, Friendly)' },
        { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah (Female, American, Soft)' },
        { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice (Female, British, Confident)' },
        { voice_id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill (Male, American, Trustworthy)' },
        // ── LEGACY PREMADE VOICES (expire Dec 31 2026) ──
        { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam (Male, American, Deep)' },
        { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni (Male, American, Well-rounded)' },
        { voice_id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold (Male, American, Crisp)' },
        { voice_id: 'CYw3kZ02Hs0563khs1Fj', name: 'Dave (Male, British-Essex, Conversational)' },
        { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi (Female, American, Strong)' },
        { voice_id: 'ThT5KcBeYPX3keUQqHPh', name: 'Dorothy (Female, British, Pleasant)' },
        { voice_id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew (Male, American, Well-rounded)' },
        { voice_id: 'LcfcDJNUP1GQjkzn1xUU', name: 'Emily (Female, American, Calm)' },
        { voice_id: 'g5CIjZEefAph4nQFvHAz', name: 'Ethan (Male, American, ASMR)' },
        { voice_id: 'D38z5RcWu1voky8WS1ja', name: 'Fin (Male, Irish, Sailor)' },
        { voice_id: 'jsCqWAovK2LkecY7zXl4', name: 'Freya (Female, American, Expressive)' },
        { voice_id: 'jBpfuIE2acCO8z3wKNLl', name: 'Gigi (Female, American, Childlike)' },
        { voice_id: 'zcAOhNBS3c14rBihAFp1', name: 'Giovanni (Male, English-Italian)' },
        { voice_id: 'z9fAnlkpzviPz146aGWa', name: 'Glinda (Female, American, Witch)' },
        { voice_id: 'oWAxZDx7w5VEj9dCyTzz', name: 'Grace (Female, American Southern)' },
        { voice_id: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry (Male, American, Anxious)' },
        { voice_id: 'ZQe5CZNOzWyzPSCn5a3c', name: 'James (Male, Australian, Calm)' },
        { voice_id: 'bVMeCyTHy58xNoL34h3p', name: 'Jeremy (Male, American-Irish, Excited)' },
        { voice_id: 't0jbNlBVZ17f02VDIeMI', name: 'Jessie (Male, American, Raspy)' },
        { voice_id: 'Zlb1dXrM653N07WRdFW3', name: 'Joseph (Male, British, News)' },
        { voice_id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh (Male, American, Deep)' },
        { voice_id: 'flq6f7yk4E4fJM5XTYuZ', name: 'Michael (Male, American, Old)' },
        { voice_id: 'zrHiDhphv9ZnVXBqCLjz', name: 'Mimi (Female, English-Swedish, Childish)' },
        { voice_id: 'piTKgcLEGmPE4e6mEKli', name: 'Nicole (Female, American, Whisper)' },
        { voice_id: 'ODq5zmih8GrVes37Dizd', name: 'Patrick (Male, American, Shouty)' },
        { voice_id: '5Q0t7uMcjvnagumLfvZi', name: 'Paul (Male, American, News Reporter)' },
        { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel (Female, American, Calm)' },
        { voice_id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam (Male, American, Raspy)' },
        { voice_id: 'pMsXgVXv3BLzUgSXRplE', name: 'Serena (Female, American, Pleasant)' },
        { voice_id: 'GBv7mTt0atIp3Br8iCZE', name: 'Thomas (Male, American, Calm)' },
        { voice_id: 'knrPHWnBmmDHMoiMeP3l', name: 'Santa Claus (Male, Christmas)' },
      ]});
    });

    app.get('/tts-audio/:id', (req: any, res: any) => {
      const entry = audioCache.get(req.params.id);
      if (!entry || Date.now() > entry.expires) {
        res.status(404).send('Not found');
        return;
      }
      // cache expires automatically after 60s
      res.set('Content-Type', 'audio/mpeg');
      res.send(entry.buf);
    });

    // ── Speaker gap calibration ───────────────────────────────────────────────
    app.post('/api/calibrate-speaker-gap', async (req: any, res: any) => {
      const userId = resolveUser(req);
      if (!userId) return res.json({ gapMs: 3500 });
      const s = getState(userId);
      const entries: { ts: string; text: string; gapMs: number }[] = req.body?.entries || [];
      if (!entries.length) return res.json({ gapMs: 3500 });
      try {
        const listing = entries.map((e, i) =>
          `${i + 1}. [${e.ts}] (gap: ${e.gapMs}ms) ${e.text}`
        ).join('\n');
        const prompt = `You are analyzing a voice transcript from smart glasses to calibrate speaker diarization.\nHere are the first 5 utterances with the silence gap before each:\n${listing}\nBased on the rhythm of this conversation (interview, meeting, monologue, Q&A, etc.),\nwhat silence gap in milliseconds best indicates a speaker change?\nReply with ONLY a JSON object: { "gapMs": <number between 1500 and 8000> }\nNo explanation, no markdown, just the JSON.`;
        const raw = await callAI([{ role: 'user', content: prompt }], s.genParams);
        // Extract the JSON from the response
        const match = raw.match(/\{[^}]+\}/);
        if (!match) throw new Error('No JSON in response');
        const parsed = JSON.parse(match[0]);
        let gapMs = typeof parsed.gapMs === 'number' ? parsed.gapMs : 3500;
        gapMs = Math.max(1500, Math.min(8000, Math.round(gapMs)));
        console.log(`[SpeakerCalib] ${userId} calibrated gap to ${gapMs}ms`);
        return res.json({ gapMs });
      } catch (err: any) {
        console.log(`[SpeakerCalib] ${userId} calibration error: ${err.message} — using default`);
        return res.json({ gapMs: 3500 });
      }
    });

    app.get('/', serve);
    app.get('/webview', serve);
    app.get('/health', (_req: any, res: any) => res.json({ status: 'healthy' }));

    console.log('[Routes] / /webview /health /clear /mic /prompt /upload /api/params /api/models /api/stream /tts-audio/:id /api/calibrate-speaker-gap registered');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Glasses-optimized system prompt: short, plain text, no markdown
const DEFAULT_SYSTEM = 'You are a concise AI assistant on smart glasses. Give short clear answers. Use 2-4 sentences max. No markdown, no bullet points, no numbered lists. Plain sentences only. Be direct and concise. Never use asterisks, hashes, or formatting symbols.';

// ── Dashboard ─────────────────────────────────────────────────────────────────
// updateDashboard writes a persistent status to the G1 always-on overlay.
// Compact line: "GeauxAI | <status>" — always visible.
// Expanded view: full block shown when user looks up / opens dashboard.
// All writes are wrapped in try/catch — display failures are non-critical.
function updateDashboard(
  session: AppSession,
  status: string,
  detail?: string,
  msgCount?: number
) {
  try {
    // Compact always-on line
    (session.dashboard.content as any).writeToMain(`GeauxAI | ${status}`);

    // Expanded view (shown when user looks up)
    const expanded: string[] = [
      'GeauxAI Labs',
      `Model: ${AI_MODEL}`,
      `Status: ${status}`,
    ];
    if (detail) expanded.push(detail);
    if (msgCount !== undefined) expanded.push(`Messages: ${msgCount}`);
    (session.dashboard.content as any).writeToExpanded(expanded.join('\n'));
  } catch (e) {
    // Dashboard content API not available on this firmware — fall back silently
    try {
      (session.dashboard.content as any).writeToMain(`GeauxAI | ${status}`);
    } catch { /* non-critical, continue */ }
    console.log('[Dashboard] Write failed:', e);
  }
}

// ── SimpleStorage: persist user preferences across server restarts ────────────

async function saveUserPrefs(session: AppSession, userId: string): Promise<void> {
  try {
    const s = getState(userId);
    const prefs = {
      ttsEnabled: s.ttsEnabled,
      ttsEngine:  s.ttsEngine,
      micMuted:   s.micMuted,
      genParams:  s.genParams,
    };
    await (session as any).simpleStorage.set('userPrefs', JSON.stringify(prefs));
    console.log(`[Storage] Saved prefs for ${userId}`);
  } catch (err: any) {
    console.log(`[Storage] Save failed: ${err.message}`);
  }
}

async function loadUserPrefs(session: AppSession, userId: string): Promise<void> {
  try {
    const raw = await (session as any).simpleStorage.get('userPrefs');
    if (!raw) return;
    const prefs = JSON.parse(raw);
    const s = getState(userId);
    if (typeof prefs.ttsEnabled === 'boolean')                         s.ttsEnabled = prefs.ttsEnabled;
    if (prefs.ttsEngine === 'kokoro' || prefs.ttsEngine === 'elevenlabs' || prefs.ttsEngine === 'elevenlabs_direct') s.ttsEngine = prefs.ttsEngine;
    if (typeof prefs.micMuted   === 'boolean')                         s.micMuted   = prefs.micMuted;
    if (prefs.genParams) {
      if (prefs.genParams.systemPrompt)                    s.genParams.systemPrompt = prefs.genParams.systemPrompt;
      if (typeof prefs.genParams.temperature === 'number') s.genParams.temperature  = prefs.genParams.temperature;
      if (typeof prefs.genParams.topP        === 'number') s.genParams.topP         = prefs.genParams.topP;
      if (typeof prefs.genParams.maxTokens   === 'number') s.genParams.maxTokens    = prefs.genParams.maxTokens;
      if (prefs.genParams.model)                           s.genParams.model        = prefs.genParams.model;
      if (typeof prefs.genParams.useCloudflare === 'boolean') s.genParams.useCloudflare = prefs.genParams.useCloudflare;
      if (typeof prefs.genParams.elevenLabsVoiceId === 'string') s.genParams.elevenLabsVoiceId = prefs.genParams.elevenLabsVoiceId;
      if (typeof prefs.genParams.elevenDirectVoiceId === 'string') s.genParams.elevenDirectVoiceId = prefs.genParams.elevenDirectVoiceId;
      if (typeof prefs.genParams.kokoroVoice === 'string') s.genParams.kokoroVoice = prefs.genParams.kokoroVoice;
      if (typeof prefs.genParams.avatarEnabled === 'boolean') s.genParams.avatarEnabled = prefs.genParams.avatarEnabled;
      if (typeof prefs.genParams.browserMicEnabled === 'boolean') s.genParams.browserMicEnabled = prefs.genParams.browserMicEnabled;
    }
    console.log(`[Storage] Loaded prefs for ${userId}: tts=${s.ttsEnabled} engine=${s.ttsEngine} mic=${s.micMuted ? 'off' : 'on'}`);
  } catch (err: any) {
    console.log(`[Storage] Load failed: ${err.message}`);
  }
}

async function handlePrompt(userId: string, prompt: string, session: AppSession | undefined) {
  const state = getState(userId);
  if (state.isProcessing) {
    console.log(`[Busy] Dropped prompt for ${userId}: still processing`);
    return;
  }
  cancelAutoClearTimer(userId);
  cancelStatusClearTimer(userId);
  state.isProcessing = true;
  broadcastToUser(userId, 'state', { processing: true, searching: false, micMuted: state.micMuted, ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine, connected: activeSessions.has(userId), reload: false });

  // Update dashboard: thinking
  if (session) updateDashboard(session, 'Thinking...', truncate(prompt, 30), state.history.length);
  console.log(`[Prompt] "${prompt.substring(0, 60)}"`);

  try {
    let searchContext = '';
    const shouldSearch = WEB_SEARCH_ENABLED && state.genParams.webSearch && detectSearchIntent(prompt);
    if (shouldSearch) {
      const searchPreview = truncate(prompt, 45);
      try { await session?.layouts.showTextWall(`Q: ${searchPreview}\n\n🔍 Searching...`); } catch {}
      broadcastToUser(userId, 'state', { processing: true, searching: true, micMuted: state.micMuted, ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine, connected: activeSessions.has(userId), reload: false });
      // Update dashboard: searching
      if (session) updateDashboard(session, 'Searching...', truncate(prompt, 30), state.history.length);
      console.log(`[Search] Triggered for: "${prompt.substring(0, 60)}"`);
      searchContext = await webSearch(prompt);
    }

    // Show thinking indicator (replaces search indicator if search ran)
    const thinkPreview = truncate(prompt, 45);
    try { await session?.layouts.showTextWall(`Q: ${thinkPreview}\n\nThinking...`); } catch {}

    state.history.push({ role: 'user', content: prompt });
    // Trim history to prevent context overflow before sending to AI
    if (state.history.length > MAX_HISTORY_PAIRS * 2) {
      state.history = state.history.slice(-(MAX_HISTORY_PAIRS * 2));
    }
    const response = await callAI(state.history, state.genParams, searchContext);

    // Sanity check: detect runaway/looping response before display
    let safeResponse = response;
    if (response.length > MAX_RESPONSE_CHARS) {
      const chunk = response.slice(0, 30);
      const repeatCount = (response.match(
        new RegExp(chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      ) || []).length;
      if (repeatCount >= 3) {
        console.log('[AI] ⚠️ Runaway/looping response detected, truncating');
        safeResponse = response.slice(0, MAX_RESPONSE_CHARS) + '... [response truncated]';
      } else {
        safeResponse = response.slice(0, MAX_RESPONSE_CHARS);
      }
    }

    const clean = stripMarkdown(safeResponse);
    console.log(`[AI] "${clean.substring(0, 80)}"`);
    state.history.push({ role: 'assistant', content: clean });
    state.lastResponse = clean;
    if (state.history.length > MAX_HISTORY_PAIRS * 2) {
      state.history = state.history.slice(-(MAX_HISTORY_PAIRS * 2));
    }

    // ── Release processing lock BEFORE showOnGlasses ─────────────────────
    // showOnGlasses sleeps PAGE_DELAY between each glasses page.
    // Keeping isProcessing=true during those sleeps holds the webview in
    // "Thinking..." mode and keeps fast-refreshing long after the AI has
    // actually finished. Release the lock now — the response is already in
    // state.history so the next 4s webview refresh shows the full response
    // while showOnGlasses quietly pages through the glasses display in the bg.
    state.isProcessing  = false;
    state.pendingRefresh = false;
    broadcastToUser(userId, 'state', { processing: false, searching: false, micMuted: state.micMuted, ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine, connected: activeSessions.has(userId), reload: true });

    // Store last prompt for Q&A header on glasses (page 1 shows Q: on top)
    state.lastPrompt = truncate(prompt, 40);

    // TTS — fire immediately so voice generates in parallel while pages display on glasses.
    // Both engines are fire-and-forget; neither blocks the display loop.
    if (state.ttsEnabled) {
      if (state.ttsEngine === 'kokoro') {
        speakWithKokoro(userId, clean, state.genParams.kokoroVoice || undefined).catch(() => {});
      } else if (state.ttsEngine === 'elevenlabs' && ELEVENLABS_API_KEY) {
        speakWithElevenLabs(session, clean, userId, state.genParams.elevenLabsVoiceId).catch(() => {});
        // Estimate audio duration from character count.
        // ElevenLabs at speed 1.1 ≈ 13 chars/sec. Add 2.5s buffer for
        // BLE transmission and speaker hardware drain.
        const elevenEstMs = Math.round((clean.length / 13) * 1000) + 2500;
        // Delay tts_start so the reloaded page has time to re-establish
        // its SSE connection before the avatar trigger arrives.
        setTimeout(() => {
          broadcastToUser(userId, 'tts_start', { engine: 'elevenlabs', estimatedMs: elevenEstMs });
        }, 1200);
      } else if (state.ttsEngine === 'elevenlabs_direct' && ELEVENLABS_API_KEY) {
        speakWithElevenLabsDirect(userId, clean, state.genParams.elevenDirectVoiceId || undefined).catch(() => {});
      }
    }

    // Apply display truncation at sentence boundary before showing on glasses
    const displayText = truncateForDisplay(clean);
    if (session) await showOnGlasses(session, displayText, userId, !!searchContext);
  } catch (err: any) {
    console.error(`[Error]`, err.message);
    try { await session?.layouts.showTextWall('GeauxAI error\n\n' + truncate(err.message, 80)); } catch {}
    if (session) updateDashboard(session, 'Error', truncate(err.message, 30));
    if (state.history.length && state.history[state.history.length - 1].role === 'user') state.history.pop();
    state.isProcessing  = false;
    state.pendingRefresh = false;
  }
}

async function handleImagePrompt(
  userId: string,
  prompt: string,
  base64: string,
  mediaType: string,
  session: AppSession
) {
  const state = getState(userId);
  if (state.isProcessing) {
    console.log(`[Busy] Dropped image prompt for ${userId}: still processing`);
    return;
  }
  cancelAutoClearTimer(userId);
  cancelStatusClearTimer(userId);
  state.isProcessing = true;
  broadcastToUser(userId, 'state', {
    processing: true, searching: false, micMuted: state.micMuted,
    ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine,
    connected: activeSessions.has(userId), reload: false,
  });
  updateDashboard(session, 'Analyzing image...', truncate(prompt, 30), state.history.length);

  try {
    let response = '';

    if (state.genParams.useCloudflare && CF_ACCOUNT_ID && CF_API_TOKEN && (state.genParams.model.trim() || '').startsWith('@cf/')) {
      // Cloudflare vision via OpenAI-compatible endpoint
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${CF_API_TOKEN}`,
          },
          body: JSON.stringify({
            model: state.genParams.model.trim() || '@cf/meta/llama-3.2-11b-vision-instruct',
            max_tokens: state.genParams.maxTokens,
            messages: [
              ...state.history,
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
                  { type: 'text', text: prompt },
                ],
              },
            ],
          }),
        }
      );
      if (!r.ok) throw new Error(`Cloudflare AI error ${r.status}`);
      response = ((await r.json()) as any).choices?.[0]?.message?.content?.trim() || 'No response.';

    } else if (AI_PROVIDER === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: state.genParams.model.trim() || AI_MODEL,
          max_tokens: state.genParams.maxTokens,
          system: state.genParams.systemPrompt.trim() || DEFAULT_SYSTEM,
          messages: [
            ...state.history,
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: base64 },
                },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      });
      if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
      response = ((await r.json()) as any).content?.find((b: any) => b.type === 'text')?.text?.trim() || 'No response.';

    } else if (AI_PROVIDER === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: state.genParams.model.trim() || AI_MODEL,
          max_tokens: state.genParams.maxTokens,
          messages: [
            ...state.history,
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      });
      if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
      response = ((await r.json()) as any).choices?.[0]?.message?.content?.trim() || 'No response.';

    } else if (AI_PROVIDER === 'ollama') {
      const modelName = (state.genParams.model.trim() || AI_MODEL).toLowerCase();
      const isVision = ['llava','moondream','minicpm-v','bakllava','llava-phi','vision'].some(v => modelName.includes(v));
      if (!isVision) {
        throw new Error(`Image upload requires a vision model (e.g. llava, moondream). Current model: ${modelName}`);
      }
      const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.genParams.model.trim() || AI_MODEL,
          stream: false,
          messages: [
            ...state.history,
            { role: 'user', content: prompt, images: [base64] },
          ],
          options: {
            temperature: state.genParams.temperature,
            top_p: state.genParams.topP,
            num_predict: state.genParams.maxTokens,
          },
        }),
      });
      if (!r.ok) throw new Error(`Ollama error ${r.status}`);
      response = ((await r.json()) as any).message?.content?.trim() || 'No response.';
    } else {
      throw new Error(`Image upload not supported for provider: ${AI_PROVIDER}`);
    }

    const clean = stripMarkdown(response);
    console.log(`[ImageAI] "${clean.substring(0, 80)}"`);

    state.history.push({ role: 'user', content: `[Image] ${prompt}` });
    state.history.push({ role: 'assistant', content: clean });
    if (state.history.length > MAX_HISTORY_PAIRS * 2) {
      state.history = state.history.slice(-(MAX_HISTORY_PAIRS * 2));
    }
    state.lastResponse = clean;

    state.isProcessing  = false;
    state.pendingRefresh = false;
    broadcastToUser(userId, 'state', {
      processing: false, searching: false, micMuted: state.micMuted,
      ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine,
      connected: activeSessions.has(userId), reload: true,
    });
    state.lastPrompt = truncate(`[Image] ${prompt}`, 40);

    if (state.ttsEnabled) {
      if (state.ttsEngine === 'kokoro') speakWithKokoro(userId, clean, state.genParams.kokoroVoice || undefined).catch(() => {});
      else if (state.ttsEngine === 'elevenlabs' && ELEVENLABS_API_KEY) {
        speakWithElevenLabs(session, clean, userId, state.genParams.elevenLabsVoiceId).catch(() => {});
        // Estimate audio duration from character count.
        // ElevenLabs at speed 1.1 ≈ 13 chars/sec. Add 2.5s buffer for
        // BLE transmission and speaker hardware drain.
        const elevenEstMs = Math.round((clean.length / 13) * 1000) + 2500;
        // Delay tts_start so the reloaded page has time to re-establish
        // its SSE connection before the avatar trigger arrives.
        setTimeout(() => {
          broadcastToUser(userId, 'tts_start', { engine: 'elevenlabs', estimatedMs: elevenEstMs });
        }, 1200);
      } else if (state.ttsEngine === 'elevenlabs_direct' && ELEVENLABS_API_KEY) {
        speakWithElevenLabsDirect(userId, clean, state.genParams.elevenDirectVoiceId || undefined).catch(() => {});
      }
    }

    const displayText = truncateForDisplay(clean);
    await showOnGlasses(session, displayText, userId, false);

  } catch (err: any) {
    console.error(`[ImageAI Error]`, err.message);
    try { await session.layouts.showTextWall('GeauxAI error\n\n' + truncate(err.message, 80)); } catch {}
    updateDashboard(session, 'Error', truncate(err.message, 30));
    state.history.push({ role: 'user', content: `[Image] ${prompt}` });
    state.history.push({ role: 'assistant', content: `⚠️ ${err.message}` });
    broadcastToUser(userId, 'state', {
      processing: false, searching: false, micMuted: state.micMuted,
      ttsEnabled: state.ttsEnabled, ttsEngine: state.ttsEngine,
      connected: activeSessions.has(userId), reload: true,
    });
    state.isProcessing  = false;
    state.pendingRefresh = false;
  }
}

async function transcribeAudio(buffer: Buffer, filename: string, mime: string): Promise<string> {
  if (!OPENAI_KEY) return '';
  try {
    const formData = new FormData();
    const blob = new Blob([buffer], { type: mime || 'audio/mpeg' });
    formData.append('file', blob, filename);
    formData.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}` },
      body: formData,
    });
    if (!r.ok) throw new Error(`Whisper error ${r.status}`);
    const data = (await r.json()) as any;
    const text = data.text?.trim() || '';
    console.log(`[Whisper] Transcribed ${buffer.length} bytes → "${text.substring(0, 80)}"`);
    return text;
  } catch (err: any) {
    console.log(`[Whisper] Failed: ${err.message}`);
    return '';
  }
}

async function callAI(history: { role: string; content: string }[], params: GenParams, searchContext?: string): Promise<string> {
  // Use the user's custom system prompt if set, otherwise fall back to the built-in default.
  const mainSystem = params.systemPrompt.trim() || DEFAULT_SYSTEM;
  // Use per-user selected model if set, otherwise fall back to server default.
  const modelToUse = params.model.trim() || AI_MODEL;

  // ── Cloudflare Workers AI (OpenAI-compatible endpoint) ────────────────────
  // Only route to Cloudflare if the selected model is actually a CF model (@cf/...)
  // This prevents sending Ollama model names (e.g. "deepseek-v3.2:cloud") to CF API
  if (params.useCloudflare && CF_ACCOUNT_ID && CF_API_TOKEN && modelToUse.startsWith('@cf/')) {
    const cfSystem = searchContext ? searchContext + '\n\n' + mainSystem : mainSystem;
    const messages = [{ role: 'system', content: cfSystem }, ...history];
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CF_API_TOKEN}`,
        },
        body: JSON.stringify({
          model: modelToUse,
          messages,
          max_tokens: params.maxTokens,
          temperature: params.temperature,
          top_p: params.topP,
          stream: false,
        }),
      }
    );
    if (!r.ok) {
      const errBody = await r.text().catch(() => '');
      throw new Error(`Cloudflare AI error ${r.status}: ${errBody.substring(0, 200)}`);
    }
    return ((await r.json()) as any).choices?.[0]?.message?.content?.trim() || 'No response.';
  }

  if (AI_PROVIDER === 'ollama') {
    const ollamaSystem = searchContext ? searchContext + '\n\n' + mainSystem : mainSystem;
    const messages = [{ role: 'system', content: ollamaSystem }, ...history];
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelToUse,
        messages,
        stream: false,
        options: {
          temperature: params.temperature,
          top_p:       params.topP,
          num_predict: params.maxTokens,
        },
      }),
    });
    if (!r.ok) throw new Error(`Ollama error ${r.status}`);
    return ((await r.json()) as any).message?.content?.trim() || 'No response.';
  }

  if (AI_PROVIDER === 'anthropic') {
    const system = searchContext ? searchContext + '\n\n' + mainSystem : mainSystem;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: modelToUse,
        system,
        messages:    history,
        max_tokens:  params.maxTokens,
        temperature: params.temperature,
        top_p:       params.topP,
      }),
    });
    if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
    return ((await r.json()) as any).content?.find((b: any) => b.type === 'text')?.text?.trim() || 'No response.';
  }

  // OpenAI (default)
  const openaiSystem = searchContext ? searchContext + '\n\n' + mainSystem : mainSystem;
  const messages = [{ role: 'system', content: openaiSystem }, ...history];
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: modelToUse,
      messages,
      max_tokens:  params.maxTokens,
      temperature: params.temperature,
      top_p:       params.topP,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
  return ((await r.json()) as any).choices?.[0]?.message?.content?.trim() || 'No response.';
}

// ── Display: Zone 3 — AI Response ────────────────────────────────────────────
// Shows paginated AI responses on the G1 glasses.
// Strategy: showReferenceCard(title, text) → showTextWall fallback.
// SDK uses separate string args — NOT an object: showReferenceCard(title: string, text: string, options?)
async function showOnGlasses(
  session: AppSession,
  text: string,
  userId?: string,
  fromSearch: boolean = false
) {
  if (!text?.trim()) return;

  // Paginate with 5 lines/page (full G1 display real estate)
  const contentPages = paginate(text, 44, 5);
  const total = contentPages.length;

  // Store pages in user state for button navigation
  const userState = userId ? getState(userId) : null;
  if (userState) {
    userState.pages = contentPages;
    userState.pageIndex = 0;
  }

  // ── Main paginated display loop ───────────────────────────────────────────
  for (let i = 0; i < contentPages.length; i++) {
    const pageNum  = i + 1;
    const pageText = contentPages[i];
    const isLast   = i === contentPages.length - 1;
    const prefix   = fromSearch ? 'Search' : 'GeauxAI';

    // Update page index in user state for button nav tracking
    if (userState) userState.pageIndex = i;

    // All pages: showTextWall — full-width display, confirmed working on G1.
    // Page 0 with a stored question: prepend "Q: ..." header for context.
    // Pages 2+: prepend "[N/Total]" page indicator.
    // showDoubleTextWall and showReferenceCard are NOT used — both render
    // incorrectly on the G1's 640x200 monochrome display.
    if (i === 0 && userId) {
      const qs = getState(userId);
      if (qs.lastPrompt) {
        try { await session.layouts.showTextWall(`Q: ${qs.lastPrompt}\n\n${pageText}`); } catch {}
      } else {
        try { await session.layouts.showTextWall(pageText); } catch {}
      }
    } else {
      const header = total > 1 ? `[${prefix} ${pageNum}/${total}]\n` : '';
      try { await session.layouts.showTextWall(header + pageText); } catch {}
    }

    if (!isLast) await sleep(PAGE_DELAY);
  }

  // ── Post-display: auto-clear timer + dashboard update ─────────────────────
  if (userId) {
    const s = getState(userId);
    // If Kokoro TTS is active, speakWithKokoro handles its own auto-clear timer
    if (s.ttsEnabled && s.ttsEngine === 'kokoro') {
      updateDashboard(session, 'Ready', `Last: ${truncate(text, 25)}`, s.history.length);
      return;
    }
    cancelAutoClearTimer(userId);
    s.autoClearTimer = setTimeout(async () => {
      s.autoClearTimer = null;
      const activeSession = activeSessions.get(userId!);
      if (activeSession) {
        try { await activeSession.layouts.clearView(); } catch {}
        console.log(`[AutoClear] Display cleared for ${userId}`);
      }
    }, AUTO_CLEAR_DELAY_MS);
    console.log(`[AutoClear] Timer started for ${userId} (${AUTO_CLEAR_DELAY_MS}ms)`);
    updateDashboard(session, 'Ready', `Last: ${truncate(text, 25)}`, s.history.length);
  }
}

// ── Pagination ────────────────────────────────────────────────────────────────
// Splits text into glasses-sized pages.
// cpl=44: characters per line (G1 640px wide, SDK font fits ~40-46 chars)
// lpp=5 : lines per page (G1 display fits 5 lines comfortably)
// Handles words longer than line width without silent truncation.
function paginate(text: string, cpl = 44, lpp = 5): string[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const lines: string[] = [];
  let cur = '';

  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= cpl) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      if (w.length > cpl) {
        // Break long word across multiple lines
        let remaining = w;
        while (remaining.length > cpl) {
          lines.push(remaining.substring(0, cpl));
          remaining = remaining.substring(cpl);
        }
        cur = remaining;
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);

  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += lpp) {
    pages.push(lines.slice(i, i + lpp).join('\n'));
  }
  return pages.length ? pages : ['(empty)'];
}

function stripMarkdown(t: string): string {
  return t.replace(/\*\*(.+?)\*\*/g,'$1').replace(/\*(.+?)\*/g,'$1')
    .replace(/`(.+?)`/g,'$1').replace(/#+\s*/g,'').replace(/^[-•*]\s+/gm,'')
    .replace(/^\d+\.\s+/gm,'').replace(/\n{3,}/g,'\n\n').trim();
}

function truncate(t: string, max: number): string {
  return t.length <= max ? t : t.substring(0, max - 3) + '...';
}

// Truncate AI response at a natural sentence boundary for the glasses display.
// Finds the last sentence-ending punctuation before MAX_DISPLAY_CHARS to avoid
// cutting mid-sentence.
function truncateForDisplay(text: string, max: number = MAX_DISPLAY_CHARS): string {
  if (text.length <= max) return text;
  const truncated = text.substring(0, max);
  const lastPeriod   = truncated.lastIndexOf('.');
  const lastQuestion = truncated.lastIndexOf('?');
  const lastExclaim  = truncated.lastIndexOf('!');
  const lastBreak    = Math.max(lastPeriod, lastQuestion, lastExclaim);
  // Only use sentence boundary if it's in the second half of the truncation window
  if (lastBreak > max * 0.5) {
    return truncated.substring(0, lastBreak + 1);
  }
  return truncated.trim() + '...';
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function webSearch(query: string): Promise<string> {
  if (!TAVILY_API_KEY || !WEB_SEARCH_ENABLED) return '';
  try {
    // Auto-detect topic: 'news' for current-events queries, 'general' for everything else
    const newsSignals = /\b(news|headlines|today|breaking|war|election|president|trump|biden|congress|senate|politics|weather|stock|market|crisis|attack|bombing|killed|dead|earthquake|hurricane|tornado|flood|shooting|police|protest|iran|ukraine|russia|china|military|ceasefire|sanctions|tariff|inflation|economy|fed|rate|GDP)\b/i;
    const searchTopic = newsSignals.test(query) ? 'news' : 'general';
    console.log(`[Search] Topic: ${searchTopic} for: "${query.substring(0, 60)}"`);

    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth:        'advanced',  // deeper crawl, 2 credits/search
        include_answer:       true,        // Tavily AI-generated summary
        include_raw_content:  false,       // keep false to control context size
        max_results:          8,           // more sources
        topic:               searchTopic, // auto-detected: 'news' or 'general'
      }),
    });
    if (!r.ok) { console.log(`[WebSearch] Tavily error: HTTP ${r.status}`); return ''; }
    const data = await r.json() as any;

    const lines: string[] = [];
    const now = new Date().toISOString();
    lines.push('===WEB SEARCH RESULTS===');
    lines.push(`Query: "${query}"`);
    lines.push(`Date: ${now}`);
    lines.push('');

    if (data.answer && data.answer.trim()) {
      lines.push(`Summary: ${data.answer.trim()}`);
      lines.push('');
    }

    const results = (data.results || []).slice(0, 6);
    results.forEach((res: any, i: number) => {
      const title   = (res.title            || '').trim();
      const content = (res.content          || '').trim().substring(0, 500);
      const url     = (res.url              || '').trim();
      const pubDate = (res.published_date   || '').trim();
      if (title || content) {
        lines.push(`${i + 1}. ${title}`);
        if (pubDate) lines.push(`   Published: ${pubDate}`);
        if (url)     lines.push(`   Source: ${url}`);
        if (content) lines.push(`   ${content}`);
        lines.push('');
      }
    });

    lines.push('===END SEARCH RESULTS===');
    lines.push(`Use these results to answer comprehensively. Today's date is ${now}. Cite sources when possible.`);

    const count = results.length;
    if (count === 0 && !data.answer) {
      console.log(`[WebSearch] No results for: "${query}"`);
      return '';
    }
    console.log(`[WebSearch] Tavily "${query}" → ${count} results` + (data.answer ? ' + summary' : ''));
    return lines.join('\n');
  } catch (err: any) {
    console.log(`[WebSearch] Failed: ${err.message}`);
    return '';
  }
}

async function speakWithElevenLabs(session: AppSession | undefined, text: string, userId: string, voiceId?: string): Promise<void> {
  if (!ELEVENLABS_API_KEY) return;
  try {
    const safeText = text.length > 10000 ? text.slice(0, 9997) + '...' : text;
    if (!session) {
      console.log(`[TTS] ElevenLabs skipped — no glasses session for ${userId}`);
      return;
    }
    const result = await (session.audio as any).speak(safeText, {
      voice_id: (voiceId || ELEVENLABS_VOICE_ID) || undefined,
      voice_settings: {
        stability:        0.5,
        similarity_boost: 0.75,
        speed:            1.1,
      },
    });
    if (result?.success) {
      const durSec = typeof result.duration === 'number' ? result.duration : null;
      console.log(`[TTS] ElevenLabs spoke ${safeText.length} chars (${durSec ?? '?'}s) for ${userId}`);
    } else {
      console.log(`[TTS] ElevenLabs failed: ${result?.error ?? 'unknown error'}`);
    }
    // Broadcast tts_end so the webview avatar stops animating
    broadcastToUser(userId, 'tts_end', { engine: 'elevenlabs' });
  } catch (err: any) {
    console.log(`[TTS] ElevenLabs error: ${err.message}`);
    broadcastToUser(userId, 'tts_end', { engine: 'elevenlabs' });
  }
}

async function speakWithElevenLabsDirect(userId: string, text: string, voiceId?: string): Promise<void> {
  if (!ELEVENLABS_API_KEY) return;
  try {
    const safeText = text.length > 10000 ? text.slice(0, 9997) + '...' : text;
    const vid = voiceId || '21m00Tcm4TlvDq8ikWAM';
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: safeText,
        model_id: 'eleven_flash_v2',
        voice_settings: {
          stability:        0.5,
          similarity_boost: 0.75,
          speed:            1.1,
        },
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.log(`[TTS] ElevenLabs Direct error ${r.status}: ${errText.slice(0, 120)}`);
      broadcastToUser(userId, 'tts_end', { engine: 'elevenlabs_direct' });
      return;
    }
    const audioBuffer = Buffer.from(await r.arrayBuffer());
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    audioCache.set(id, { buf: audioBuffer, expires: Date.now() + 300_000 });
    const audioUrl = `/tts-audio/${id}`;
    broadcastToUser(userId, 'tts_audio', { url: audioUrl });
    console.log(`[TTS] ElevenLabs Direct → SSE audio push (${safeText.length} chars, voice: ${vid})`);
    cancelAutoClearTimer(userId);
    const ds = getState(userId);
    ds.autoClearTimer = setTimeout(async () => {
      ds.autoClearTimer = null;
      const dSession = activeSessions.get(userId);
      if (dSession) {
        try { await dSession.layouts.clearView(); } catch {}
        updateDashboard(dSession, 'Ready');
        console.log(`[AutoClear] Display cleared for ${userId}`);
      }
    }, AUTO_CLEAR_DELAY_MS);
    console.log(`[AutoClear] Timer started for ${userId} (${AUTO_CLEAR_DELAY_MS}ms) [post-ElevenDirect]`);
  } catch (err: any) {
    console.log(`[TTS] ElevenLabs Direct failed: ${err.message}`);
    broadcastToUser(userId, 'tts_end', { engine: 'elevenlabs_direct' });
  }
}

async function speakWithKokoro(userId: string, text: string, voiceOverride?: string): Promise<void> {
  try {
    const safeText = text.length > 10000 ? text.slice(0, 9997) + '...' : text;
    const r = await fetch(`${KOKORO_HOST}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        input: safeText,
        voice: (voiceOverride || KOKORO_VOICE) || 'af_bella',
        response_format: 'mp3',
        speed: 1.0,
      }),
    });
    if (!r.ok) {
      console.log(`[TTS] Kokoro error ${r.status}`);
      return;
    }
    const audioBuffer = Buffer.from(await r.arrayBuffer());
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    audioCache.set(id, { buf: audioBuffer, expires: Date.now() + 300_000 });
    const audioUrl = `/tts-audio/${id}`;
    broadcastToUser(userId, 'tts_audio', { url: audioUrl });
    console.log(`[TTS] Kokoro → SSE audio push (${safeText.length} chars, voice: ${voiceOverride || KOKORO_VOICE})`);
    cancelAutoClearTimer(userId);
    const ks = getState(userId);
    ks.autoClearTimer = setTimeout(async () => {
      ks.autoClearTimer = null;
      const kSession = activeSessions.get(userId);
      if (kSession) {
        try { await kSession.layouts.clearView(); } catch {}
        updateDashboard(kSession, 'Ready');
        console.log(`[AutoClear] Display cleared for ${userId}`);
      }
    }, AUTO_CLEAR_DELAY_MS);
    console.log(`[AutoClear] Timer started for ${userId} (${AUTO_CLEAR_DELAY_MS}ms) [post-Kokoro]`);
  } catch (err: any) {
    console.log(`[TTS] Kokoro failed: ${err.message}`);
  }
}

function detectSearchIntent(prompt: string): boolean {
  const p = prompt.toLowerCase();
  const signals = [
    // Time/recency
    'today','tonight','right now','current','currently','latest','recent',
    'recently','this week','this month','this year','just happened',
    'breaking','live','now','last night','yesterday',
    'just announced','just released','just launched','new update','update on',
    // Questions needing live data
    'what is the weather','weather in','weather for',
    'what is the score','who won',"what's the score",
    'what happened','who is the current','who is the new',
    'what is the latest',"what's happening",'whats happening',
    'is there a','did they announce','has it been released',
    "what's the price",'how much does','how much is',"what's the stock",
    'stock price','market today',
    'who is the president','who is the ceo','who is the',
    'what time does','when does','when did','when is',
    'is it open','are they open','hours for',
    'how do i get to','directions to','near me',
    'best rated','reviews for','rating of',
    // Explicit search requests
    'search for','look up','find out','google',
    'search the web','look it up','can you find',
    'what does the internet say','find me',
    // News and events
    'news','score','scores','election','results',
    'announcement','release date','coming out',
    'box office','standings','rankings','leaderboard',
    'championship','playoffs','season','episode',
    'trailer','review',
  ];
  return signals.some(s => p.includes(s));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
// Validate required env vars before starting
if (!API_KEY) {
  console.error('\n❌  MENTRA_API_KEY is not set in your .env file.\n');
  process.exit(1);
}
if (!OWNER_EMAIL) {
  console.warn('\n⚠️   OWNER_EMAIL is not set. Webview will require a valid MentraOS auth token.');
  console.warn('    Set OWNER_EMAIL=your@email.com in .env for local dev fallback.\n');
}

const server = new GeauxAIApp({ packageName: PACKAGE_NAME, apiKey: API_KEY, port: PORT });
server.addRoutes();
server.start();

console.log('');
console.log('════════════════════════════════════════════');
console.log('  GeauxAI Labs — GeauxAiPrompt  (MentraOS)');
console.log('════════════════════════════════════════════');
console.log(`  Package : ${PACKAGE_NAME}`);
console.log(`  Port    : ${PORT}`);
console.log(`  AI      : ${AI_PROVIDER} / ${AI_MODEL}`);
console.log(`  Search  : ${TAVILY_API_KEY ? 'Tavily (live web)' : 'DISABLED — set TAVILY_API_KEY in .env'}`);
console.log(`  CloudAI : ${CF_API_TOKEN ? 'Cloudflare Workers AI (enabled)' : 'DISABLED — set CF_ACCOUNT_ID & CF_API_TOKEN in .env'}`);
console.log(`  TTS     : ${ELEVENLABS_API_KEY ? 'ElevenLabs (voice enabled)' : 'DISABLED — set ELEVENLABS_API_KEY in .env'}`);
console.log(`  Kokoro  : ${KOKORO_HOST} (voice: ${KOKORO_VOICE})`);
console.log(`  Mode    : VOICE ALWAYS ON + LIVE CHAT LOG`);
console.log(`  Method  : SSE real-time push`);
console.log(`  AI Tools: ask_geauxai, web_search (Mira integration)`);
console.log('════════════════════════════════════════════');
console.log('');
