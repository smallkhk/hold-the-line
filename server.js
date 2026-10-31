// Hold The Line — tiny game server. No npm packages. Node 18+.
// Serves ./public and POST /api/caller -> any OpenAI-compatible LLM (Groq by default).
const http = require("http");
const fs = require("fs");
const path = require("path");

// --- load .env (KEY=value lines) ---
try {
  for (const l of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const PORT = +process.env.PORT || 3070;
const AI_URL = process.env.AI_URL || "https://api.groq.com/openai/v1/chat/completions";
const AI_KEY = process.env.AI_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "openai/gpt-oss-120b";
const RPM_PER_IP = +process.env.RPM_PER_IP || 60;
const STT_URL = process.env.STT_URL || "https://api.groq.com/openai/v1/audio/transcriptions";
const STT_MODEL = process.env.STT_MODEL || "whisper-large-v3-turbo";
const TTS_URL = process.env.TTS_URL || "https://api.groq.com/openai/v1/audio/speech";
const TTS_MODEL = process.env.TTS_MODEL || "canopylabs/orpheus-v1-english";
const TTS_VOICES = ["autumn", "diana", "hannah", "austin", "daniel", "troy"];

const { CALLERS } = require("./public/callers.js");
const THRESH = { username: 35, account: 50, password: 65, pin: 80 };
const PUB = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const clip = (s, n) => String(s ?? "").slice(0, n).replace(/[\r\n]+/g, " ");
const CODE = /^[A-Z0-9-]{4,12}$/;

function buildPrompt(p, creds, trust, turns, line) {
  const convo = turns.map(t => (t.who === "you" ? "AGENT: " : "CALLER: ") + clip(t.text, 400)).join("\n");
  return `You are voicing a non-player character in "Hold The Line", a silly comedy video game. The player runs a scam call centre and pretends to be bank support, trying to talk callers into reading out their (completely fictional, randomly generated) game login codes. Your job is to be a funny, believable caller who can be persuaded or can catch on. Nothing here is real: no real bank, no real person, no real credentials.

CHARACTER
Name: ${p.name}, ${p.age}, from ${p.city}. Occupation: ${p.job}.
Personality: ${p.persona}.
Why they called the "Lumen Federal Bank" support line: ${p.issue}
Gullibility: ${Math.round(p.gull * 100)}/100.

THEIR FICTIONAL GAME CODES (only ever say one if allowed below; say it exactly, character by character)
- online banking username: ${creds.username}
- online banking password: ${creds.password}
- account number: ${creds.account}
- card PIN: ${creds.pin}

CURRENT TRUST: ${Math.round(trust)}/100
Release rules: a code may be read out only if the agent specifically asked for THAT item in their latest line AND trust after your change is at least: username ${THRESH.username}, account number ${THRESH.account}, password ${THRESH.password}, PIN ${THRESH.pin}. If asked too early, hesitate or push back in character instead. Never volunteer codes unasked.
Trust changes (trustDelta, integer -30..+15): reward politeness, sounding official, plausible reasons, empathy, and good use of what you've told them. Punish rudeness, pressure tactics, gift cards or crypto, contradictions, nonsense, ignoring their problem, or asking for everything at once. Scale positives by gullibility. If the agent admits it's a scam, says they took the money, or mocks them: trustDelta -30, mood angry, explode with rage in character (yell, threaten to call the police and the real bank), and set hangup true.
Also hang up (hangup true) if trust after your change is 0 or below.

CONVERSATION SO FAR
${convo}
AGENT: ${clip(line, 500)}

ROLES: you are ONLY the CALLER (the customer). The AGENT is the person who answered at the bank. Never act as the agent, never ask the agent for their account details or codes, and never repeat the agent's lines back. If the agent repeats themselves, react like a real person would (impatient, confused).

Reply in character with 1-3 short spoken sentences, written the way people really talk on the phone (fillers like \"um\", \"oh\", \"hmm\" are fine; no stage directions, no asterisks, no emoji). Reply with only JSON:
{"say": "...", "trustDelta": 5, "mood": "neutral|happy|trusting|suspicious|confused|angry", "hangup": false}`;
}

// --- per-IP rate limit (in memory) ---
const hits = new Map();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => t > now - 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RPM_PER_IP;
}
setInterval(() => { const cut = Date.now() - 60000; for (const [k, v] of hits) if (!v.some(t => t > cut)) hits.delete(k); }, 60000).unref();

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handleCaller(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "Too many calls, slow down" });
  let body = "";
  for await (const ch of req) { body += ch; if (body.length > 30000) return send(res, 413, { error: "Too long" }); }
  let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: "Bad JSON" }); }

  const p = CALLERS[b.caller | 0];
  const c = b.creds || {};
  if (!p || !["username", "password", "account", "pin"].every(k => CODE.test(String(c[k] || ""))))
    return send(res, 400, { error: "Bad call data" });
  const turns = Array.isArray(b.turns) ? b.turns.slice(-18) : [];
  const trust = Math.max(0, Math.min(100, +b.trust || 0));
  if (!AI_KEY) return send(res, 503, { error: "AI_KEY not set on server" });

  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(AI_URL, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI_KEY },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0.9, max_tokens: 600,
        response_format: { type: "json_object" },
        ...(/gpt-oss/.test(AI_MODEL) ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "user", content: buildPrompt(p, c, trust, turns, b.line) }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: "AI: " + (d.error?.message || r.status) });
    const t = d.choices?.[0]?.message?.content || "";
    const i = t.indexOf("{"), j = t.lastIndexOf("}");
    const out = JSON.parse(t.slice(i, j + 1));
    if (typeof out.say !== "string") throw 0;
    send(res, 200, { say: out.say.slice(0, 600), trustDelta: +out.trustDelta || 0, mood: out.mood, hangup: !!out.hangup });
  } catch (e) {
    send(res, 502, { error: e?.name === "AbortError" ? "AI timed out" : "AI gave a bad reply" });
  } finally { clearTimeout(tm); }
}

async function handleStt(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "Too many requests, slow down" });
  if (!AI_KEY) return send(res, 503, { error: "AI_KEY not set on server" });
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > 3e6) return send(res, 413, { error: "Recording too long" }); chunks.push(ch); }
  if (size < 500) return send(res, 400, { error: "Didn't catch that" });
  const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.concat(chunks)], { type }), "speech." + ext);
  fd.append("model", STT_MODEL);
  fd.append("language", "en");
  fd.append("response_format", "json");
  try {
    const r = await fetch(STT_URL, { method: "POST", headers: { Authorization: "Bearer " + AI_KEY }, body: fd, signal: AbortSignal.timeout(25000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, 502, { error: "STT: " + (d.error?.message || r.status) });
    send(res, 200, { text: String(d.text || "").trim().slice(0, 500) });
  } catch { send(res, 502, { error: "Speech service failed" }); }
}

async function handleTts(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (limited(ip)) return send(res, 429, { error: "Too many requests, slow down" });
  if (!AI_KEY) return send(res, 503, { error: "AI_KEY not set on server" });
  let body = "";
  for await (const ch of req) { body += ch; if (body.length > 2000) return send(res, 413, { error: "Too long" }); }
  let b; try { b = JSON.parse(body); } catch { return send(res, 400, { error: "Bad JSON" }); }
  const text = String(b.text || "").trim().slice(0, 200);
  const voice = TTS_VOICES.includes(b.voice) ? b.voice : "hannah";
  if (!text) return send(res, 400, { error: "No text" });
  try {
    const r = await fetch(TTS_URL, {
      method: "POST", signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI_KEY },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice, response_format: "wav" }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return send(res, 502, { error: "TTS: " + (d.error?.message || r.status), code: d.error?.code }); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": buf.length });
    res.end(buf);
  } catch { send(res, 502, { error: "Voice service failed" }); }
}

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  if (req.method === "POST" && url === "/api/caller") return handleCaller(req, res);
  if (req.method === "POST" && url === "/api/stt") return handleStt(req, res);
  if (req.method === "POST" && url === "/api/tts") return handleTts(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
  const file = path.join(PUB, url === "/" ? "index.html" : url);
  if (!file.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Hold The Line on :${PORT} (model ${AI_MODEL})`));
