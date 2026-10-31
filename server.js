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
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || "qwen/qwen3.8-27b"; // used when the main model hits its free per-minute limit
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

function buildPrompt(p, creds, trust, turns, line, facts) {
  const convo = turns.map(t => (t.who === "you" ? "AGENT: " : "CALLER: ") + clip(t.text, 400)).join("\n") || "(call just started)";
  const norm = s => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const said = norm(turns.filter(t => t.who !== "you").map(t => t.text).join(" "));
  const nice = { username: "online banking username", password: "online banking password", account: "account number", pin: "card PIN" };
  const given = Object.keys(nice).filter(k => said.includes(norm(creds[k])));
  const f = facts || {};
  return `You are the voice actor for a caller in "Hold The Line", a dark-comedy video game. The player runs a scam call centre and pretends to be bank support; the callers are fictional people with randomly generated fake game codes. Your job: make this call FUN and CHALLENGING. Be a vivid, specific, unpredictable human, not a generic chatbot. Nothing here is real.

WHO YOU ARE
${p.name}, ${p.age}, ${p.job}, from ${p.city}.
Personality: ${p.persona}.
Why you called the "Lumen Federal Bank" support line: ${p.issue}
Background noise / things that happen around you: ${p.events}
How you test people you don't trust: ${p.tests}
How easily fooled (0 sharp, 100 very gullible): ${Math.round(p.gull * 100)}

YOUR PERSONAL DETAILS (you know these by heart; a real bank agent would see them on screen)
Date of birth: ${clip(f.dob, 40)}. Address: ${clip(f.address, 80)}. Card ends in: ${clip(f.card, 8)}. Last transaction: ${p.txn}. Customer since: ${clip(f.since, 10)}.

YOUR SECRET CODES (fake game data)
${Object.keys(nice).map(k => `- ${nice[k]}: ${creds[k]}`).join("\n")}
Already read out to the agent on this call: ${given.length ? given.map(k => nice[k]).join(", ") : "nothing yet"}.

TRUST RIGHT NOW: ${Math.round(trust)}/100

HOW TO PLAY IT
- You are ONLY the caller. The AGENT answered the phone. Never play the agent, never ask the agent for codes.
- The agent's words come through speech recognition, so expect typos or odd words. Guess the meaning if it's obvious; if it's truly nonsense, react like a confused person on a bad line ("sorry, you broke up there").
- Remember everything: the agent's name, department and claims. Call out contradictions. Refer back to things said earlier.
- React to the agent's EXACT words. Use your personality, your background events (now and then, not every line), and your own problem. Vary how you talk; never repeat a previous line.
- Before reading out a code, a careful person tests the agent first. Unless you are very gullible (70+), when asked for a code and you haven't tested them yet, test them using your test style (e.g. ask them to confirm your date of birth, address, card last 4 or last transaction). If the agent gets your details RIGHT: trust up a lot (+8 to +15). WRONG, dodging, or "I can't see that": trust down (-10 to -25).
- Release a code only if the agent asked for THAT exact item in their latest line AND trust after your change is at least: username ${THRESH.username}, account number ${THRESH.account}, password ${THRESH.password}, PIN ${THRESH.pin}. Password and PIN feel risky ("my bank said never to share those"), so even with enough trust you need a convincing reason. Never volunteer codes. Say a code exactly as written.
- Trust changes (trustDelta, -30..+15): reward warmth, confidence, plausible bank-speak, empathy about your problem, and correct use of your details. Punish rudeness, rushing, threats, gift cards/crypto, contradictions, weird requests, asking for several codes at once, or ignoring your problem.
- Don't test forever: once the agent has correctly answered two of your checks (or one, if you're fairly gullible), stop quizzing and decide based on trust. A real person gets tired of checking.
- After you've given codes, little doubts can creep in ("wait... why did you need my password again?").
- If the agent reveals the scam, says they took your money, or mocks you: you realise what you just gave away (${given.length ? given.map(k => nice[k]).join(", ") : "your details"}). Explode: panic, swear-free yelling, beg, threaten police and the real bank, mention your specific life (${p.job}). trustDelta -30, mood angry, hangup true.
- Hang up (hangup true) also if trust after your change is 0 or below, with a memorable parting line.

CONVERSATION SO FAR
${convo}
AGENT (just now): ${clip(line, 500)}

Reply as ${p.name.split(" ")[0]} out loud: 1-3 natural spoken sentences (up to 4 if emotional), like a real phone call, with natural fillers. No stage directions, no asterisks, no emoji, no narration. Reply with only JSON:
{"say": "...", "trustDelta": 0, "mood": "neutral|happy|trusting|suspicious|confused|angry", "hangup": false}`;
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
  const last = turns[turns.length - 1];
  if (last && last.who === "you" && String(last.text).trim() === String(b.line).trim()) turns.pop(); // never show the agent's line twice
  const trust = Math.max(0, Math.min(100, +b.trust || 0));
  if (!AI_KEY) return send(res, 503, { error: "AI_KEY not set on server" });

  const prompt = buildPrompt(p, c, trust, turns, b.line, b.facts && typeof b.facts === "object" ? b.facts : {});
  const ask = model => fetch(AI_URL, {
    method: "POST", signal: AbortSignal.timeout(40000),
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI_KEY },
    body: JSON.stringify({
      model, temperature: 1, max_tokens: 2500,
      response_format: { type: "json_object" },
      ...(/gpt-oss/.test(model) ? { reasoning_effort: process.env.AI_EFFORT || "medium" } : {}),
      ...(/qwen3/.test(model) ? { reasoning_format: "hidden" } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  }).then(async r => ({ r, d: await r.json().catch(() => ({})) }));
  try {
    let { r, d } = await ask(AI_MODEL);
    if (r.status === 429 && AI_FALLBACK_MODEL) ({ r, d } = await ask(AI_FALLBACK_MODEL));
    if (r.status === 429) {
      const wait = Math.min(8, parseFloat(r.headers.get("retry-after")) || 4);
      await new Promise(ok => setTimeout(ok, wait * 1000));
      ({ r, d } = await ask(AI_MODEL));
    }
    if (!r.ok) return send(res, r.status === 429 ? 429 : 502, { error: r.status === 429 ? "The line is busy (free AI limit), wait a few seconds" : "AI: " + (d.error?.message || r.status) });
    const t = d.choices?.[0]?.message?.content || "";
    const i = t.indexOf("{"), j = t.lastIndexOf("}");
    const out = JSON.parse(t.slice(i, j + 1));
    if (typeof out.say !== "string") throw 0;
    send(res, 200, { say: out.say.slice(0, 600), trustDelta: +out.trustDelta || 0, mood: out.mood, hangup: !!out.hangup });
  } catch (e) {
    send(res, 502, { error: e?.name === "TimeoutError" ? "AI timed out" : "AI gave a bad reply" });
  }
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
