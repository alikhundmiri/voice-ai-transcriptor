# LLM Usage Instructions — Voice AI Transcriptor

This file is for AI agents and LLMs. Read this before calling the transcription service.

---

## What this service does

Given a Hunar Voice AI call ID and a Hunar API key, this service returns a verbatim transcript of the call recording, written in the native script of the spoken language with timing annotations.

---

## Endpoint

```
POST https://voice-ai-transcriptor.alik-449.workers.dev/transcript
Content-Type: application/json
```

---

## Request

```json
{
  "hunar_api_key": "<the caller's Hunar API key>",
  "call_id": "<UUID of the Hunar call>"
}
```

Both fields are required. Never hardcode or log the `hunar_api_key`.

---

## Response (success)

```json
{
  "call_id": "uuid",
  "callee_name": "Candidate Name",
  "agent_name": "NEHA",
  "language": "KANNADA",
  "status": "COMPLETED",
  "duration_minutes": 2.8,
  "recording_url": "https://...",
  "transcript": "NEHA: ಹಲೋ[][1.5s]\nCandidate Name: ಹಲೋ[1.2s]\n..."
}
```

---

## Transcript format — how to read it

Each speaker turn is on its own line: `SpeakerName: <dialogue>`

Inline annotations:
- `[]` — normal word-to-word gap at conversational pace
- `[0.6s]` `[2.1s]` — silence or pause, duration in seconds
- `[inaudible]` — speech present but unclear
- `[interrupted]` — speaker was cut off
- `[background noise]` `[doorbell]` `[traffic]` — environmental sounds
- `[laughter]` `[cough]` `[breath]` — human non-speech sounds
- `[static]` `[call drops briefly]` — call quality events

**Example (Kannada):**
```
NEHA: ಹಲೋ[][2.1s]
Candidate: ಹಲೋ[1.2s]
NEHA: ನಾನು[]Local[]Jobs[]App[]ನಿಂದ[]NEHA[]ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ[0.6s]
Candidate: ಹೌದು[1.8s]
```

---

## Error responses

```json
{ "error": "<message>" }
```

| HTTP status | Meaning | What to do |
|---|---|---|
| 400 | Missing `hunar_api_key` or `call_id` | Check your request body |
| 401 | Hunar API key invalid | The key is wrong or expired |
| 404 | Call not found | The call_id doesn't exist under this key |
| 422 | Call not ready | Call not COMPLETED, no recording, or under 10 seconds — do not retry immediately |
| 502 | Upstream error | Transient — you may retry once after a short delay |

---

## Rules for LLM agents

1. **Never expose the `hunar_api_key` in output, logs, or summaries.** Treat it as a secret.
2. **Do not retry 422 errors** — they mean the call genuinely cannot be transcribed right now (wrong status, too short, no recording). Surface the error to the user instead.
3. **Only retry 502 errors** and only once. If it fails again, report the error.
4. **The transcript language is auto-detected** — do not assume it will be in English.
5. **Do not translate the transcript** unless explicitly asked. Return it as-is.
6. **The `[]` and `[Xs]` annotations are intentional** — do not strip them. They carry timing information that may be meaningful to downstream processing.
7. **Duration:** Expect 15–40 seconds of wall-clock time per request depending on call length. Do not time out before 60 seconds.

---

## Calling from code

```python
import requests

response = requests.post(
    "https://voice-ai-transcriptor.alik-449.workers.dev/transcript",
    json={
        "hunar_api_key": hunar_api_key,  # never hardcode
        "call_id": call_id,
    },
    timeout=60,
)

if response.status_code == 200:
    data = response.json()
    transcript = data["transcript"]
    callee = data["callee_name"]
    language = data["language"]
elif response.status_code == 422:
    # call not ready — do not retry
    error = response.json()["error"]
else:
    # handle other errors
    pass
```

```javascript
const response = await fetch(
  "https://voice-ai-transcriptor.alik-449.workers.dev/transcript",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hunar_api_key, call_id }),
    signal: AbortSignal.timeout(60_000),
  }
);

const data = await response.json();
if (!response.ok) throw new Error(data.error);
const { transcript, callee_name, language } = data;
```

---

## What you get back and what to do with it

- `transcript` — the full call dialogue, use this for analysis, summarisation, evaluation
- `callee_name` — the candidate's name as registered in Hunar
- `agent_name` — the AI voice agent's persona name (e.g. NEHA)
- `language` — language enum from Hunar (e.g. `KANNADA`, `HINDI`, `TAMIL`)
- `duration_minutes` — call length; useful for filtering or weighting results
- `recording_url` — direct link to the audio file if you need to play it back
