# Hold The Line

Scam call centre comedy game. Customers ring the "bank support line" (you). Talk them into reading out their fake banking details, punch them into Account Link, get paid. AI callers (Groq, free tier), callers speak with browser TTS, you talk back with the mic.

No npm packages. Node 18+.

## Install (Ubuntu / EC2)

```bash
git clone https://github.com/smallkhk/hold-the-line.git && cd hold-the-line
AI_KEY=gsk_your_groq_key DOMAIN=game.yourdomain.com bash install.sh
```

Point the domain's A record at the server first. Mic needs https.
Without `DOMAIN` it just runs on port 3070 under PM2.

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
| `RPM_PER_IP` | 20 |

Any OpenAI-compatible provider works: change `AI_URL`, `AI_MODEL`, `STT_URL`.
