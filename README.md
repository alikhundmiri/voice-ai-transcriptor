# Voice AI Transcriptor

A Cloudflare Worker that transcribes Hunar Voice AI call recordings using Gemini 2.5 Flash. Returns a rich, multi-dimensional transcript in the native script of the spoken language — with word-level timing, pause durations, and audio events embedded inline.

## What it does

1. Accepts a Hunar API key + call ID
2. Fetches call details and recording from Hunar
3. Sends the audio to Gemini 2.5 Flash
4. Returns a verbatim transcript with speaker labels, timing, and audio events

**Supported languages:** All Hunar-supported languages — Hindi, Kannada, Tamil, Telugu, Malayalam, Gujarati, Bengali, Marathi, Turkish, Arabic, Spanish, English. Transcripts are written in native script (not transliterated).

---

## API

### `POST /transcript`

**Request body:**

```json
{
  "hunar_api_key": "hunar_va_live_sk_...",
  "call_id": "uuid-of-the-call"
}
```

**Response:**

```json
{
  "call_id": "uuid",
  "callee_name": "Akash N Yadav",
  "agent_name": "NEHA",
  "language": "KANNADA",
  "status": "COMPLETED",
  "duration_minutes": 2.8,
  "recording_url": "https://...",
  "transcript": "NEHA: ಹಲೋ[][1.5s]\nAkash N Yadav: ಹಲೋ[1.2s]\n..."
}
```

**Transcript format:**

| Notation | Meaning |
|---|---|
| `[]` | Normal gap between words at conversational pace |
| `[0.8s]` `[3.2s]` | Measured pause in seconds |
| `[inaudible]` | Speech not clear enough to transcribe |
| `[interrupted]` | Speaker cut off mid-sentence |
| `[background noise]` `[doorbell]` | Environmental sounds |
| `[laughter]` `[cough]` | Human non-speech sounds |
| `[static]` `[call drops briefly]` | Call quality events |

**Error codes:**

| Status | Meaning |
|---|---|
| 400 | Missing `hunar_api_key` or `call_id` |
| 401 | Hunar API key rejected |
| 404 | Call not found |
| 422 | Call not COMPLETED, no recording, or under 10 seconds |
| 502 | Upstream error from Hunar or Gemini |

### `GET /documentation`

Public HTML documentation page. Open in any browser.

---

## Setup & Deployment

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- A Google AI Studio API key with Gemini 2.5 Flash access

### 1. Install dependencies

```bash
npm install
```

### 2. Create KV namespace

```bash
npx wrangler kv namespace create API_KEYS
```

Copy the `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Create D1 database

```bash
npx wrangler d1 create voice-transcriptor-logs
```

Copy the `database_id` into `wrangler.toml` under `[[d1_databases]]`. Then create the schema:

```bash
npx wrangler d1 execute voice-transcriptor-logs --remote --command "
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  client_id TEXT,
  client_email TEXT,
  call_id TEXT,
  callee_name TEXT,
  agent_name TEXT,
  language TEXT,
  duration_seconds REAL,
  success INTEGER NOT NULL,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  thinking_tokens INTEGER,
  model TEXT,
  cost_usd REAL,
  transcript TEXT
);"
```

### 4. Set secrets

```bash
# Your Google Gemini API key
npx wrangler secret put GEMINI_API_KEY

# A random key to protect the /admin dashboard
npx wrangler secret put ADMIN_KEY
```

Generate a strong admin key:
```bash
openssl rand -hex 20
```

### 5. Deploy

```bash
npx wrangler deploy
```

### 6. Access the admin dashboard

```
https://<your-worker>.workers.dev/admin?key=<your-ADMIN_KEY>
```

Keep this URL private — it shows all request logs, token usage, and Gemini costs.

---

## Local development

```bash
npx wrangler dev
```

---

## Guardrails

- Call must have status `COMPLETED`
- Call must have a recording URL
- Call must be **≥ 10 seconds** — shorter calls are rejected without hitting Gemini
- Gemini thinking mode is **disabled** — not needed for transcription, reduces cost ~46×

## Cost model

Uses Gemini 2.5 Flash with thinking disabled:
- Input: `$0.075 / 1M tokens`
- Output: `$0.30 / 1M tokens`

A typical 3-minute call costs approximately `$0.001–0.003`. The admin dashboard tracks per-request cost and running totals.

Pricing constants are in `src/index.ts` under `PRICING` — update if Google changes rates.
