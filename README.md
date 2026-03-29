# InnerVoice

AI-powered affirmation app that clones your voice and delivers personalized daily affirmations.

## Quick start

```bash
cp .env.example .env
# Add your OPENAI_API_KEY to .env
npm install
npm start
# Open http://localhost:3000
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes | GPT-4o for affirmation generation |
| `ELEVENLABS_API_KEY` | No | Voice cloning + TTS. Without it, text-only mode. |
| `PORT` | No | Server port (default: 3000) |

## Endpoints

- `POST /api/generate-affirmation` — multipart form: `goal` (string) + optional `voiceFile` (audio)
- `GET /api/health` — status check
