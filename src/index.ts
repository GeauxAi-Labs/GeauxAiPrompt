import { AppServer, AppSession } from '@mentra/sdk';

// ── Config ────────────────────────────────────────────────────────────────────
const PORT         = parseInt(process.env.PORT || '3000');
const PACKAGE_NAME = process.env.PACKAGE_NAME || 'com.geauxailabs.geauxaiprompt';
const API_KEY      = process.env.MENTRA_API_KEY || '';
const AI_PROVIDER  = process.env.AI_PROVIDER   || 'ollama';
const AI_MODEL     = process.env.AI_MODEL      || 'llama3.2';
const OPENAI_KEY   = process.env.OPENAI_API_KEY   || '';
const ANTHROPIC_KEY= process.env.ANTHROPIC_API_KEY|| '';
const OLLAMA_HOST  = process.env.OLLAMA_HOST   || 'http://localhost:11434';
const PAGE_DELAY   = parseInt(process.env.PAGE_DELAY_MS || '5000');
const OWNER_EMAIL  = process.env.OWNER_EMAIL || '';

// ── State ─────────────────────────────────────────────────────────────────────
interface UserState {
  history:      { role: string; content: string }[];
  lastResponse: string;
  isProcessing: boolean;
  micMuted:     boolean;
}
const userStates     = new Map<string, UserState>();
const activeSessions = new Map<string, AppSession>();

function getState(userId: string): UserState {
  if (!userStates.has(userId)) {
    userStates.set(userId, { history: [], lastResponse: '', isProcessing: false, micMuted: false });
  }
  return userStates.get(userId)!;
}

function esc(t: string): string {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// Build the full HTML page with conversation baked in — no JS required at all.
// The page auto-refreshes every 4 seconds via <meta http-equiv="refresh">.
// This works in ANY WebView, any browser, zero JavaScript needed.
function buildPage(connected: boolean, processing: boolean, history: {role:string;content:string}[], micMuted: boolean): string {
  const statusText = processing ? '⏳ Thinking...' : connected ? '🟢 Connected — speak into your glasses' : '⚪ Waiting for glasses connection...';
  const pillClass  = processing ? 'thinking' : connected ? 'connected' : 'waiting';
  const pillLabel  = processing ? '● THINKING' : connected ? '● CONNECTED' : '● WAITING';

  let bubbles = '';
  if (history.length === 0) {
    bubbles = `
      <div class="empty">
        <div class="icon">🎤</div>
        <div class="t">Voice Chat Log</div>
        <div class="sub">Speak into your G1 glasses.<br>Your conversation will appear here live.</div>
      </div>`;
  } else {
    for (const msg of history) {
      const isUser = msg.role === 'user';
      bubbles += `
      <div class="msg">
        <div class="lbl ${isUser ? 'you' : 'ai'}">${isUser ? 'YOU' : 'AI'}</div>
        <div class="bbl ${isUser ? 'you' : 'ai'}">${esc(msg.content)}</div>
      </div>`;
    }
    if (processing) {
      bubbles += `
      <div class="msg" id="thinking">
        <div class="lbl ai">AI</div>
        <div class="bbl ai"><span class="dots">●&nbsp;●&nbsp;●</span></div>
      </div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<meta http-equiv="refresh" content="4">
<title>GeauxAiPrompt</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080c10;--card:#0d1420;--cy:#06b6d4;--txt:#e2e8f0;
  --mu:#64748b;--bd:#1e293b;--gr:#10b981;--am:#f59e0b;--rd:#ef4444;
}
html,body{background:var(--bg);color:var(--txt);font-family:system-ui,sans-serif;min-height:100%}
.app{display:flex;flex-direction:column;min-height:100dvh;max-width:520px;margin:0 auto}

header{
  position:sticky;top:0;z-index:10;
  padding:10px 16px 8px;
  border-bottom:1px solid var(--bd);
  display:flex;align-items:center;gap:10px;
  background:var(--bg);
  flex-shrink:0;
}
.logo{font-family:monospace;font-size:11px;font-weight:700;color:var(--cy);flex:1;letter-spacing:.05em}
.pill{
  font-family:monospace;font-size:10px;font-weight:700;
  padding:4px 9px;border-radius:99px;border:1.5px solid;
}
.pill.waiting{border-color:var(--mu);color:var(--mu)}
.pill.connected{border-color:var(--gr);color:var(--gr);background:#0a1a0a}
.pill.thinking{border-color:var(--am);color:var(--am);background:#1a1200}
.newchat{
  font-family:monospace;font-size:10px;font-weight:700;
  padding:4px 9px;border-radius:99px;
  border:1.5px solid var(--rd);color:var(--rd);
  background:transparent;cursor:pointer;
  -webkit-appearance:none;appearance:none;
}
.newchat:active{background:#1a0505}
.mic-btn{
  font-family:monospace;font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:99px;
  border:1.5px solid;cursor:pointer;
  -webkit-appearance:none;appearance:none;
  background:transparent;
}
.mic-btn.live{border-color:var(--gr);color:var(--gr)}
.mic-btn.live:active{background:#0a1a0a}
.mic-btn.muted{border-color:var(--rd);color:var(--rd)}
.mic-btn.muted:active{background:#1a0505}

.statusbar{
  display:flex;align-items:center;gap:8px;padding:5px 16px;
  background:var(--card);border-bottom:1px solid var(--bd);
  flex-shrink:0;
}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:var(--mu)}
.dot.ok{background:var(--gr)}
.dot.busy{background:var(--am)}
.stxt{font-size:10px;color:var(--mu);font-family:monospace}

.feed{
  flex:1;padding:12px 16px 80px;
  display:flex;flex-direction:column;gap:10px;
}
.empty{
  flex:1;display:flex;flex-direction:column;
  align-items:center;justify-content:center;
  gap:8px;color:var(--mu);text-align:center;padding:32px;margin-top:60px;
}
.empty .icon{font-size:32px;margin-bottom:4px}
.empty .t{font-size:15px;font-weight:600;color:var(--txt)}
.empty .sub{font-size:12px;line-height:1.6}
.msg{animation:fi .25s ease-out}
@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.lbl{font-size:9px;letter-spacing:.12em;text-transform:uppercase;font-family:monospace;margin-bottom:3px}
.lbl.you{color:var(--cy)}.lbl.ai{color:var(--gr)}
.bbl{
  padding:10px 13px;border-radius:10px;
  font-size:14px;line-height:1.55;word-break:break-word;
}
.bbl.you{background:#0e2a42;border:1px solid #1a4a6e;max-width:92%}
.bbl.ai{background:var(--card);border:1px solid var(--bd);max-width:92%}
.dots{letter-spacing:4px;color:var(--am);animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

footer{
  position:fixed;bottom:0;left:0;right:0;
  max-width:520px;margin:0 auto;
  padding:8px 16px 12px;
  border-top:1px solid var(--bd);
  background:var(--bg);
  display:flex;align-items:center;gap:8px;
}
.mic-icon{font-size:18px}
.mic-label{font-family:monospace;font-size:11px;color:var(--mu)}
.hint{font-family:monospace;font-size:10px;color:var(--bd);flex:1;text-align:right}
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="logo">⬡ GEAUXAILABS / GEAUXAIPROMPT</div>
    <div class="pill ${pillClass}">${pillLabel}</div>
    <form method="POST" action="/mic" style="margin:0;padding:0">
      <button type="submit" class="mic-btn ${micMuted ? 'muted' : 'live'}">${micMuted ? '🔇 MIC OFF' : '🎤 MIC ON'}</button>
    </form>
    <form method="POST" action="/clear" style="margin:0;padding:0">
      <button type="submit" class="newchat">✕ NEW CHAT</button>
    </form>
  </header>
  <div class="statusbar">
    <div class="dot ${processing ? 'busy' : connected ? 'ok' : ''}"></div>
    <div class="stxt">${esc(statusText)}</div>
  </div>
  <div class="feed">
    ${bubbles}
  </div>
  <footer>
    <div class="hint" style="flex:1;text-align:right">powered by GeauxAI Labs</div>
  </footer>
</div>
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
html,body{background:#080c10;color:#e2e8f0;font-family:system-ui,sans-serif;
  min-height:100%;display:flex;align-items:center;justify-content:center;
  text-align:center;padding:32px}
.wrap{max-width:300px}
.icon{font-size:40px;margin-bottom:16px}
h2{font-size:17px;color:#06b6d4;margin-bottom:10px;font-family:monospace;letter-spacing:.05em}
p{font-size:13px;color:#64748b;line-height:1.65}
</style>
</head>
<body>
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
    activeSessions.set(userId, session);

    await session.layouts.showTextWall(
      'GeauxAI Labs\nGeauxAiPrompt Ready\n\nSpeak to send prompts.\nChat log visible on phone.'
    );

    // Button: long-press clears history, single-tap replays last response.
    // SDK type says pressType is "short" | "long" — we log the raw value so
    // we can confirm what the G1 actually sends in production if long-press
    // still doesn't fire (it may be a hardware/app-level issue on the G1).
    session.events.onButtonPress(async (data: any) => {
      const pressType: string = data.pressType || '';
      console.log(`[Button] pressType="${pressType}" raw=${JSON.stringify(data)}`);
      const s = getState(userId);
      // Accept 'long' (SDK spec) and 'long_press' defensively in case SDK version differs
      if (pressType === 'long' || pressType === 'long_press') {
        s.history = []; s.lastResponse = '';
        console.log(`[Button] Long press — history cleared for ${userId}`);
        try { await session.layouts.showTextWall('History cleared.\nReady for new prompts.'); } catch {}
      } else {
        if (s.lastResponse) {
          try { await showOnGlasses(session, s.lastResponse); } catch {}
        }
      }
    });

    // Transcription: always-on mic
    session.events.onTranscription(async (data: any) => {
      if (!data.isFinal) return;
      const s2 = getState(userId);
      if (s2.micMuted) return;  // mic toggled off from webview
      const text = data.text?.trim();
      if (!text || text.length < 3) return;
      await handlePrompt(userId, text, session);
    });
  }

  protected async onStop(sessionId: string, userId: string, reason: string) {
    console.log(`[Session] Stopped: ${userId} (${reason})`);
    activeSessions.delete(userId);
  }

  public addRoutes() {
    const app = this.getExpressApp();
    const owner = OWNER_EMAIL;

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
      const s = getState(owner);
      const html = buildPage(
        activeSessions.has(owner),
        s.isProcessing,
        s.history,
        s.micMuted
      );
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    };

    // POST /clear — "New Chat" button submits this form.
    // Clears server-side history, notifies glasses if connected,
    // then redirects back so the browser reloads a fresh empty page.
    app.post('/clear', async (req: any, res: any) => {
      const s = getState(owner);
      s.history = [];
      s.lastResponse = '';
      console.log('[WebClear] History cleared via New Chat button');
      const session = activeSessions.get(owner);
      if (session) {
        try { await session.layouts.showTextWall('History cleared.\nReady for new prompts.'); } catch {}
      }
      res.redirect(303, '/webview');
    });

    app.post('/mic', async (req: any, res: any) => {
      const s = getState(owner);
      s.micMuted = !s.micMuted;
      console.log(`[MicToggle] micMuted=${s.micMuted}`);
      const session = activeSessions.get(owner);
      if (session) {
        const msg = s.micMuted ? 'Microphone muted.\nTap MIC ON in the app to resume.' : 'Microphone active.\nSpeak into your glasses.';
        try { await session.layouts.showTextWall(msg); } catch {}
      }
      res.redirect(303, '/webview');
    });

    app.get('/', serve);
    app.get('/webview', serve);
    app.get('/health', (_req: any, res: any) => res.json({ status: 'healthy' }));

    console.log('[Routes] / /webview /health /clear /mic registered — meta-refresh + New Chat + Mic toggle');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function handlePrompt(userId: string, prompt: string, session: AppSession) {
  const state = getState(userId);
  if (state.isProcessing) return;
  state.isProcessing = true;
  console.log(`[Prompt] "${prompt.substring(0, 60)}"`);
  try {
    await session.layouts.showTextWall(`Thinking...\n"${truncate(prompt, 60)}"`);
    state.history.push({ role: 'user', content: prompt });
    const response = await callAI(state.history);
    const clean = stripMarkdown(response);
    console.log(`[AI] "${clean.substring(0, 80)}"`);
    state.history.push({ role: 'assistant', content: clean });
    state.lastResponse = clean;
    if (state.history.length > 40) state.history = state.history.slice(-40);
    await showOnGlasses(session, clean);
  } catch (err: any) {
    console.error(`[Error]`, err.message);
    try { await session.layouts.showTextWall(`Error:\n${truncate(err.message, 80)}`); } catch {}
    if (state.history.length && state.history[state.history.length - 1].role === 'user') state.history.pop();
  } finally {
    state.isProcessing = false;
  }
}

async function callAI(history: { role: string; content: string }[]): Promise<string> {
  const system = 'You are a concise AI assistant on smart glasses. Give short clear answers, 2-4 sentences max. No markdown, no bullet points, plain sentences only.';
  if (AI_PROVIDER === 'ollama') {
    const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, ...history], stream: false }),
    });
    if (!r.ok) throw new Error(`Ollama error ${r.status}`);
    return ((await r.json()) as any).message?.content?.trim() || 'No response.';
  }
  if (AI_PROVIDER === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: AI_MODEL, system, messages: history, max_tokens: 300 }),
    });
    if (!r.ok) throw new Error(`Anthropic error ${r.status}`);
    return ((await r.json()) as any).content?.find((b: any) => b.type === 'text')?.text?.trim() || 'No response.';
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'system', content: system }, ...history], max_tokens: 300 }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
  return ((await r.json()) as any).choices?.[0]?.message?.content?.trim() || 'No response.';
}

async function showOnGlasses(session: AppSession, text: string) {
  const pages = paginate(text);
  for (let i = 0; i < pages.length; i++) {
    const suffix = pages.length > 1 ? `\n(${i + 1}/${pages.length})` : '';
    try { await session.layouts.showTextWall(pages[i] + suffix); } catch { return; }
    if (i < pages.length - 1) await sleep(PAGE_DELAY);
  }
}

function paginate(text: string, cpl = 38, lpp = 5): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const c = cur ? `${cur} ${w}` : w;
    if (c.length <= cpl) { cur = c; } else { if (cur) lines.push(cur); cur = w.substring(0, cpl); }
  }
  if (cur) lines.push(cur);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += lpp) pages.push(lines.slice(i, i + lpp).join('\n'));
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

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Boot ──────────────────────────────────────────────────────────────────────
// Validate required env vars before starting
if (!OWNER_EMAIL) {
  console.error('\n❌  OWNER_EMAIL is not set in your .env file.');
  console.error('    Add: OWNER_EMAIL=your@email.com\n');
  process.exit(1);
}
if (!API_KEY) {
  console.error('\n❌  MENTRA_API_KEY is not set in your .env file.\n');
  process.exit(1);
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
console.log(`  Mode    : VOICE ALWAYS ON + LIVE CHAT LOG`);
console.log(`  Method  : meta-refresh every 4s, zero JS`);
console.log('════════════════════════════════════════════');
console.log('');
