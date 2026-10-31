# Hold The Line

Scam call centre comedy game. Customers ring the "bank support line" (you). Talk them into reading out their fake banking details, punch them into Account Link, get paid.

Fully voice-based: pick up and just talk, like a real call. AI callers think for themselves (Groq gpt-oss-120b), hear you (Whisper) and answer in natural human voices (Orpheus). All on Groq's free tier.

**One-time:** accept the Orpheus voice terms at https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english (until then callers use the browser's robot voice).

No npm packages. Node 18+.

## Install (Ubuntu / EC2)

```bash
git clone https://github.com/smallkhk/hold-the-line.git && cd hold-the-line
AI_KEY=gsk_your_groq_key bash install.sh
```

Open ports 80 and 443 in the EC2 security group first. With no domain, the game goes live at
`https://<server-ip-with-dashes>.sslip.io` (free hostname, real https, so the mic works).
Own domain: add `DOMAIN=game.yourdomain.com`. Skip Nginx/https: add `NO_NGINX=1` (runs on port 3070).

## Update

```bash
cd hold-the-line && git pull && bash install.sh
```

## Config (`.env`)

| Key | Default |
|---|---|
| `PORT` | 3070 |
| `AI_KEY` | Groq key (https://console.groq.com/keys) |
| `AI_MODEL` | openai/gpt-oss-120b |
| `STT_MODEL` | whisper-large-v3-turbo |
| `TTS_MODEL` | canopylabs/orpheus-v1-english |
| `RPM_PER_IP` | 60 |

Any OpenAI-compatible provider works: change `AI_URL`, `AI_MODEL`, `STT_URL`.
