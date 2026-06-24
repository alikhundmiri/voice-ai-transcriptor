export interface Env {
  GEMINI_API_KEY: string;
  ADMIN_KEY: string;
  API_KEYS: KVNamespace;
  DB: D1Database;
}

const HUNAR_BASE = 'https://api.voice.hunar.ai/external/v1';
const GEMINI_UPLOAD = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_GENERATE = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Pricing per token in USD — update if Google changes rates
// Source: https://ai.google.dev/gemini-api/docs/pricing
// thinking = price per thinking token (only applies when thinkingBudget > 0)
const PRICING: Record<string, { input: number; output: number; thinking: number }> = {
  'gemini-2.5-flash': { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000, thinking: 3.50 / 1_000_000 },
  'gemini-1.5-flash': { input: 0.075 / 1_000_000, output: 0.30 / 1_000_000, thinking: 0 },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/documentation') {
      return new Response(buildDocs(url.origin), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/admin') {
      const key = url.searchParams.get('key');
      if (!key || key !== env.ADMIN_KEY) {
        return new Response('Unauthorized', { status: 401 });
      }
      const page = parseInt(url.searchParams.get('page') ?? '1');
      return buildAdminPage(env.DB, url.origin, key, page);
    }

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (request.method !== 'POST') {
      return err(405, 'Method not allowed');
    }

    if (url.pathname !== '/transcript') {
      return err(404, 'Not found. Use POST /transcript');
    }

    let body: { hunar_api_key?: string; call_id?: string };
    try {
      body = await request.json();
    } catch {
      return err(400, 'Invalid JSON body');
    }

    const { hunar_api_key, call_id } = body;
    if (!hunar_api_key || !call_id) {
      return err(400, 'Missing required fields: hunar_api_key, call_id');
    }

    const clientId = await hashKey(hunar_api_key);

    // --- 1. Fetch call details from Hunar ---
    const callRes = await fetch(`${HUNAR_BASE}/calls/${call_id}/`, {
      headers: { 'X-API-Key': hunar_api_key },
    });

    if (callRes.status === 401) return logAndErr(env.DB, clientId, null, null, 401, 'Invalid Hunar API key');
    if (callRes.status === 404) return logAndErr(env.DB, clientId, null, null, 404, 'Call not found');
    if (!callRes.ok) return logAndErr(env.DB, clientId, null, null, 502, 'Failed to fetch call from Hunar');

    const call = (await callRes.json()) as HunarCall;
    const clientEmail = call.triggered_by ?? null;

    if (call.status !== 'COMPLETED') {
      return logAndErr(env.DB, clientId, clientEmail, call, 422, `Call is not completed — current status is "${call.status}"`);
    }
    if (!call.recording_url) {
      return logAndErr(env.DB, clientId, clientEmail, call, 422, 'No recording available for this call');
    }
    const durationSeconds = call.duration_minutes * 60;
    if (durationSeconds < 10) {
      return logAndErr(env.DB, clientId, clientEmail, call, 422, `Call too short — duration is ${durationSeconds.toFixed(1)}s (minimum 10s)`);
    }

    // --- 2 + 3. Fetch agent and download audio in parallel ---
    const [agentRes, audioRes] = await Promise.all([
      fetch(`${HUNAR_BASE}/agents/${call.agent_id}/`, { headers: { 'X-API-Key': hunar_api_key } }),
      fetch(call.recording_url),
    ]);

    let agentPersonaName = 'Agent';
    if (agentRes.ok) {
      const agent = (await agentRes.json()) as HunarAgent;
      agentPersonaName = agent.persona_name ?? agent.name ?? 'Agent';
    }

    if (!audioRes.ok) return logAndErr(env.DB, clientId, clientEmail, call, 502, 'Failed to download call recording');

    const audioBuffer = await audioRes.arrayBuffer();
    const mimeType = call.recording_url.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

    // --- 4. Upload audio to Gemini File API ---
    const boundary = 'gemini-' + Math.random().toString(36).slice(2);
    const enc = new TextEncoder();
    const metaJson = JSON.stringify({ file: { mimeType } });
    const pre = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metaJson}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const post = enc.encode(`\r\n--${boundary}--`);
    const uploadBody = new Uint8Array(pre.byteLength + audioBuffer.byteLength + post.byteLength);
    uploadBody.set(pre, 0);
    uploadBody.set(new Uint8Array(audioBuffer), pre.byteLength);
    uploadBody.set(post, pre.byteLength + audioBuffer.byteLength);

    const uploadRes = await fetch(`${GEMINI_UPLOAD}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'multipart',
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: uploadBody,
    });

    if (!uploadRes.ok) {
      const detail = await uploadRes.text();
      return logAndErr(env.DB, clientId, clientEmail, call, 502, `Gemini file upload failed: ${detail}`);
    }

    const { file } = (await uploadRes.json()) as { file: { uri: string } };

    // --- 5. Generate verbatim transcript ---
    const prompt =
      `Listen to this call recording carefully and generate a rich, multi-dimensional verbatim transcript.\n\n` +

      `SPEAKER CONTEXT:\n` +
      `- ${agentPersonaName} is the AI voice agent\n` +
      `- ${call.callee_name} is the candidate\n\n` +

      `SCRIPT RULES (most important):\n` +
      `- Write in the NATIVE SCRIPT of the language spoken. Do NOT transliterate into Latin/Roman characters.\n` +
      `  Gujarati → ગુજરાતી | Tamil → தமிழ் | Hindi/Marathi → देवनागरी | Kannada → ಕನ್ನಡ | Malayalam → മലയാളം | Telugu → తెలుగు | Bengali → বাংলা\n` +
      `- EXCEPTION: If a word is actually spoken in English, write that word in English (Latin script).\n\n` +

      `TIMING RULES:\n` +
      `- Between every word in normal flowing speech, place empty brackets: []\n` +
      `- When there is a noticeable pause (≥ 0.3 seconds), write the duration: [0.5s] [1.2s] [3.0s] etc.\n` +
      `- At the end of each speaker turn, write the silence before the next speaker responds: [2.1s]\n` +
      `- Be as accurate as possible with durations — listen carefully.\n\n` +

      `AUDIO EVENT RULES:\n` +
      `- Capture ALL non-speech sounds inline where they occur, in square brackets:\n` +
      `  [background noise] [traffic] [doorbell] [dog barking] [phone ringing] [TV in background]\n` +
      `  [laughter] [cough] [sigh] [breath] [clears throat]\n` +
      `  [interruption] [cross-talk] [talking over each other]\n` +
      `  [inaudible] [unclear] [call drops briefly] [echo] [static] [line cut]\n` +
      `  [long silence] [hold music] [automated tone]\n` +
      `- If someone is interrupted mid-sentence, end their line with [interrupted] and start the interrupter on a new line.\n` +
      `- If speech is unclear or inaudible, write [inaudible ~Xs] with approximate duration.\n\n` +

      `FORMAT:\n` +
      `Each speaker turn on its own line:\n` +
      `SpeakerName: word[]word[]word[0.8s]word[]word[2.0s]\n\n` +

      `EXAMPLE (Kannada):\n` +
      `${agentPersonaName}: ಹಲೋ[][1.5s]\n` +
      `${call.callee_name}: ಹಲೋ[1.2s]\n` +
      `${agentPersonaName}: ನಾನು[]Local[]Jobs[]App[]ನಿಂದ[]${agentPersonaName}[]ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ[0.6s]ನಾನು[]${call.callee_name}[]ಅವರ[]ಜೊತೆ[]ಮಾತನಾಡುತ್ತಿದ್ದೀನಾ?[2.1s]\n\n` +

      `Now transcribe the full call from start to finish. Do not summarize. Capture everything.`;

    const genRes = await fetch(`${GEMINI_GENERATE}?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ fileData: { mimeType, fileUri: file.uri } }, { text: prompt }] }],
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 }, // disable thinking — not needed for transcription, saves ~46x cost
        },
      }),
    });

    if (!genRes.ok) {
      const detail = await genRes.text();
      return logAndErr(env.DB, clientId, clientEmail, call, 502, `Gemini generation failed: ${detail}`);
    }

    const generated = (await genRes.json()) as GeminiResponse;
    const transcript = generated.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const inputTokens = generated.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = generated.usageMetadata?.candidatesTokenCount ?? 0;
    const thinkingTokens = generated.usageMetadata?.thoughtsTokenCount ?? 0;
    const pricing = PRICING[GEMINI_MODEL] ?? PRICING['gemini-2.5-flash'];
    const costUsd = (inputTokens * pricing.input) + (outputTokens * pricing.output) + (thinkingTokens * pricing.thinking);

    // --- 6. Log success ---
    await log(env.DB, {
      client_id: clientId,
      client_email: clientEmail,
      call_id: call.id,
      callee_name: call.callee_name,
      agent_name: agentPersonaName,
      language: call.language,
      duration_seconds: durationSeconds,
      success: true,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      thinking_tokens: thinkingTokens,
      model: GEMINI_MODEL,
      cost_usd: costUsd,
      transcript,
    });

    return cors(
      new Response(
        JSON.stringify({
          call_id: call.id,
          callee_name: call.callee_name,
          agent_name: agentPersonaName,
          language: call.language,
          status: call.status,
          duration_minutes: call.duration_minutes,
          recording_url: call.recording_url,
          transcript,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
  },
};

// --- Client ID ---

async function hashKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 10);
}

// --- Logging ---

interface LogEntry {
  client_id: string;
  client_email: string | null;
  call_id: string | null;
  callee_name?: string | null;
  agent_name?: string | null;
  language?: string | null;
  duration_seconds?: number | null;
  success: boolean;
  error?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  thinking_tokens?: number | null;
  model?: string | null;
  cost_usd?: number | null;
  transcript?: string | null;
}

async function log(db: D1Database, entry: LogEntry): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO requests
        (timestamp, client_id, client_email, call_id, callee_name, agent_name, language,
         duration_seconds, success, error, input_tokens, output_tokens, thinking_tokens, model, cost_usd, transcript)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      new Date().toISOString(),
      entry.client_id,
      entry.client_email ?? null,
      entry.call_id ?? null,
      entry.callee_name ?? null,
      entry.agent_name ?? null,
      entry.language ?? null,
      entry.duration_seconds ?? null,
      entry.success ? 1 : 0,
      entry.error ?? null,
      entry.input_tokens ?? null,
      entry.output_tokens ?? null,
      entry.thinking_tokens ?? null,
      entry.model ?? null,
      entry.cost_usd ?? null,
      entry.transcript ?? null,
    ).run();
  } catch {
    // never let logging break the response
  }
}

async function logAndErr(
  db: D1Database,
  clientId: string,
  clientEmail: string | null,
  call: HunarCall | null,
  status: number,
  message: string
): Promise<Response> {
  await log(db, {
    client_id: clientId,
    client_email: clientEmail,
    call_id: call?.id ?? null,
    callee_name: call?.callee_name ?? null,
    language: call?.language ?? null,
    duration_seconds: call ? call.duration_minutes * 60 : null,
    success: false,
    error: message,
  });
  return err(status, message);
}

// --- Admin page ---

async function buildAdminPage(db: D1Database, origin: string, key: string, page: number): Promise<Response> {
  const pageSize = 50;
  const offset = (page - 1) * pageSize;

  const [rows, stats] = await Promise.all([
    db.prepare(`SELECT * FROM requests ORDER BY id DESC LIMIT ? OFFSET ?`).bind(pageSize, offset).all(),
    db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) as successes,
        SUM(duration_seconds) as total_seconds,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        SUM(cost_usd) as total_cost
      FROM requests
    `).first<{ total: number; successes: number; total_seconds: number; total_input: number; total_output: number; total_cost: number }>(),
  ]);

  const total = stats?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const records = rows.results as unknown as RequestRow[];

  const prevLink = page > 1 ? `<a href="?key=${key}&page=${page - 1}">← Prev</a>` : `<span>← Prev</span>`;
  const nextLink = page < totalPages ? `<a href="?key=${key}&page=${page + 1}">Next →</a>` : `<span>Next →</span>`;

  // Build transcript map as one safe script block — escaping </script> prevents injection
  const transcriptMap: Record<number, string> = {};
  records.forEach(r => { if (r.transcript) transcriptMap[r.id] = r.transcript; });
  const transcriptScript = `<script>const transcripts = ${
    JSON.stringify(transcriptMap).replace(/<\/script>/gi, '<\\/script>')
  };</script>`;

  const tableRows = records.map(r => {
    const statusBadge = r.success
      ? `<span class="badge-ok">✓ OK</span>`
      : `<span class="badge-err" title="${escHtml(r.error ?? '')}">✗ Fail</span>`;
    const dur = r.duration_seconds != null ? `${r.duration_seconds.toFixed(0)}s` : '—';
    const tokens = r.input_tokens != null
      ? `${r.input_tokens.toLocaleString()} / ${(r.output_tokens ?? 0).toLocaleString()}`
      : '—';
    const cost = r.cost_usd != null ? `$${r.cost_usd.toFixed(5)}` : '—';
    const transcriptCell = r.transcript
      ? `<button class="view-btn" onclick="showTranscript(${r.id})">View</button>`
      : r.success ? '—' : `<span class="err-text" title="${escHtml(r.error ?? '')}">${escHtml((r.error ?? '').slice(0, 35))}…</span>`;

    return `<tr>
      <td>${r.id}</td>
      <td><code class="mono">${escHtml(r.client_id ?? '—')}</code></td>
      <td>${escHtml(r.client_email ?? '—')}</td>
      <td class="mono-sm">${escHtml((r.call_id ?? '—').slice(0, 8))}…</td>
      <td>${escHtml(r.callee_name ?? '—')}</td>
      <td>${escHtml(r.agent_name ?? '—')}</td>
      <td>${escHtml(r.language ?? '—')}</td>
      <td>${dur}</td>
      <td>${statusBadge}</td>
      <td>${escHtml(r.model ?? '—')}</td>
      <td class="num">${tokens}</td>
      <td class="num">${cost}</td>
      <td>${transcriptCell}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Admin — Voice AI Transcriptor</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e4e4e7; font-size: 0.8rem; }
    .header { padding: 16px 24px; border-bottom: 1px solid #27272a; display: flex; align-items: center; justify-content: space-between; }
    .header h1 { font-size: 1rem; font-weight: 600; color: #fff; }
    .header a { color: #71717a; text-decoration: none; font-size: 0.75rem; }
    .stats { display: flex; gap: 12px; padding: 16px 24px; border-bottom: 1px solid #27272a; flex-wrap: wrap; }
    .stat { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
    .stat-label { color: #71717a; font-size: 0.7rem; margin-bottom: 4px; }
    .stat-value { color: #fff; font-size: 1.2rem; font-weight: 600; }
    .table-wrap { padding: 16px 24px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; white-space: nowrap; }
    th { text-align: left; padding: 7px 10px; background: #18181b; color: #71717a; font-weight: 500; border-bottom: 1px solid #27272a; }
    td { padding: 7px 10px; border-bottom: 1px solid #1a1a1d; color: #a1a1aa; vertical-align: middle; }
    td:first-child { color: #52525b; }
    tr:hover td { background: #111113; }
    .mono { font-family: 'SF Mono', monospace; font-size: 0.75rem; color: #a78bfa; }
    .mono-sm { font-family: 'SF Mono', monospace; font-size: 0.72rem; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .badge-ok { color: #4ade80; font-weight: 600; }
    .badge-err { color: #f87171; font-weight: 600; cursor: help; }
    .err-text { color: #f87171; cursor: help; }
    .view-btn { background: #27272a; border: 1px solid #3f3f46; color: #e4e4e7; padding: 3px 10px; border-radius: 4px; cursor: pointer; font-size: 0.75rem; }
    .view-btn:hover { background: #3f3f46; }
    .pagination { display: flex; gap: 16px; align-items: center; padding: 12px 24px; color: #71717a; font-size: 0.8rem; border-top: 1px solid #27272a; }
    .pagination a { color: #a78bfa; text-decoration: none; }
    .pagination span { color: #3f3f46; }

    /* Modal */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
    .modal-overlay.open { display: flex; }
    .modal { background: #18181b; border: 1px solid #27272a; border-radius: 12px; width: min(720px, 92vw); max-height: 80vh; display: flex; flex-direction: column; }
    .modal-header { padding: 16px 20px; border-bottom: 1px solid #27272a; display: flex; justify-content: space-between; align-items: center; }
    .modal-header h2 { font-size: 0.9rem; font-weight: 600; color: #fff; }
    .modal-close { background: none; border: none; color: #71717a; cursor: pointer; font-size: 1.2rem; line-height: 1; }
    .modal-close:hover { color: #e4e4e7; }
    .modal-body { padding: 20px; overflow-y: auto; white-space: pre-wrap; line-height: 1.8; color: #d4d4d8; font-size: 0.85rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Request Log</h1>
    <a href="${origin}/documentation">View Docs →</a>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-label">Total requests</div><div class="stat-value">${total.toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Successful</div><div class="stat-value" style="color:#4ade80">${(stats?.successes ?? 0).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Failed</div><div class="stat-value" style="color:#f87171">${(total - (stats?.successes ?? 0)).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Audio processed</div><div class="stat-value">${formatDuration(stats?.total_seconds ?? 0)}</div></div>
    <div class="stat"><div class="stat-label">Total tokens in/out</div><div class="stat-value">${((stats?.total_input ?? 0) + (stats?.total_output ?? 0)).toLocaleString()}</div></div>
    <div class="stat"><div class="stat-label">Total Gemini cost</div><div class="stat-value" style="color:#fbbf24">$${(stats?.total_cost ?? 0).toFixed(4)}</div></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>#</th>
        <th>Client ID</th>
        <th>Client Email</th>
        <th>Call ID</th>
        <th>Callee</th>
        <th>Agent</th>
        <th>Language</th>
        <th>Duration</th>
        <th>Status</th>
        <th>Model</th>
        <th style="text-align:right">Tokens in / out</th>
        <th style="text-align:right">Cost (USD)</th>
        <th>Transcript</th>
      </tr></thead>
      <tbody>${tableRows || '<tr><td colspan="13" style="text-align:center;padding:32px;color:#52525b">No requests yet</td></tr>'}</tbody>
    </table>
  </div>

  <div class="pagination">
    ${prevLink}
    <span>Page ${page} of ${totalPages || 1} — ${total} total</span>
    ${nextLink}
  </div>

  <!-- Modal -->
  <div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header">
        <h2 id="modal-title">Transcript</h2>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  ${transcriptScript}
  <script>
    function showTranscript(id) {
      const t = transcripts[id] ?? '(no transcript)';
      document.getElementById('modal-title').textContent = 'Transcript — request #' + id;
      document.getElementById('modal-body').textContent = t;
      document.getElementById('modal').classList.add('open');
    }
    function closeModal() {
      document.getElementById('modal').classList.remove('open');
    }
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  </script>
</body>
</html>`;

  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function formatDuration(seconds: number): string {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Utilities ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForGeminiFile(fileUri: string, apiKey: string, maxAttempts = 10): Promise<void> {
  const fileName = fileUri.split('/').slice(-2).join('/');
  const statusUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`;
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(statusUrl);
    if (!res.ok) return;
    const data = (await res.json()) as { state?: string };
    if (data.state === 'ACTIVE') return;
    if (data.state === 'FAILED') throw new Error('Gemini file processing failed');
    await sleep(1000);
  }
}

function err(status: number, message: string): Response {
  return cors(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(response.body, { status: response.status, headers });
}

function buildDocs(origin: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Voice AI Transcriptor — API Docs</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e4e4e7; line-height: 1.6; }
    .container { max-width: 800px; margin: 0 auto; padding: 48px 24px; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #71717a; margin-bottom: 40px; font-size: 0.95rem; }
    h2 { font-size: 1.1rem; font-weight: 600; color: #fff; margin: 36px 0 12px; }
    p { color: #a1a1aa; margin-bottom: 12px; }
    .badge { display: inline-block; background: #1d4ed8; color: #bfdbfe; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 4px; margin-right: 8px; vertical-align: middle; }
    .endpoint { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 16px 20px; margin-bottom: 8px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9rem; color: #e4e4e7; }
    pre { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 20px; overflow-x: auto; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; line-height: 1.7; }
    .key { color: #60a5fa; } .val { color: #34d399; } .str { color: #fbbf24; } .comment { color: #52525b; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.875rem; }
    th { text-align: left; padding: 8px 12px; background: #18181b; color: #71717a; font-weight: 500; border-bottom: 1px solid #27272a; }
    td { padding: 10px 12px; border-bottom: 1px solid #1f1f22; color: #a1a1aa; vertical-align: top; }
    td:first-child { color: #e4e4e7; font-family: 'SF Mono', monospace; font-size: 0.8rem; }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7rem; font-weight: 600; }
    .pill-red { background: #450a0a; color: #f87171; }
    .divider { border: none; border-top: 1px solid #27272a; margin: 40px 0; }
    .warning { background: #1c1400; border: 1px solid #713f12; border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; color: #fbbf24; font-size: 0.875rem; }
    .warning strong { color: #fde68a; }
  </style>
</head>
<body>
<div class="container">
  <h1>Voice AI Transcriptor</h1>
  <p class="subtitle">Transcribes Hunar Voice AI call recordings using Gemini — verbatim, in native script, with timing, pauses, and audio events.</p>
  <hr class="divider" />
  <h2>Endpoint</h2>
  <div class="endpoint"><span class="badge">POST</span>${origin}/transcript</div>
  <h2>How it works</h2>
  <ol style="color:#a1a1aa; padding-left:20px; margin-bottom:12px;">
    <li style="margin-bottom:4px;">Validates the call is COMPLETED and ≥ 10 seconds long</li>
    <li style="margin-bottom:4px;">Fetches the recording URL and speaker names from Hunar</li>
    <li style="margin-bottom:4px;">Downloads the audio and sends it to Gemini 2.5 Flash</li>
    <li>Returns a rich multi-dimensional transcript — native script, word-level timing, pauses, and audio events</li>
  </ol>
  <hr class="divider" />
  <h2>Request</h2>
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>hunar_api_key <span class="pill pill-red">required</span></td><td>string</td><td>Your Hunar API key.</td></tr>
      <tr><td>call_id <span class="pill pill-red">required</span></td><td>string (UUID)</td><td>The Hunar call ID. Must be COMPLETED with a recording and ≥ 10 seconds.</td></tr>
    </tbody>
  </table>
  <pre><span class="comment"># Example</span>
curl -s -X POST ${origin}/transcript \\
  -H <span class="str">'Content-Type: application/json'</span> \\
  -d <span class="str">'{
    "hunar_api_key": "hunar_va_live_sk_...",
    "call_id": "150d6ac8-9bcc-4343-bbea-c5992aa94495"
  }'</span></pre>
  <h2>Response</h2>
  <table>
    <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
    <tbody>
      <tr><td>call_id</td><td>string</td><td>The Hunar call UUID</td></tr>
      <tr><td>callee_name</td><td>string</td><td>Candidate's name</td></tr>
      <tr><td>agent_name</td><td>string</td><td>AI agent persona name</td></tr>
      <tr><td>language</td><td>string</td><td>Language code (e.g. KANNADA, HINDI, GUJARATI)</td></tr>
      <tr><td>duration_minutes</td><td>number</td><td>Call duration in minutes</td></tr>
      <tr><td>recording_url</td><td>string</td><td>URL to the audio file</td></tr>
      <tr><td>transcript</td><td>string</td><td>Multi-dimensional transcript. See format below.</td></tr>
    </tbody>
  </table>
  <h2>Transcript format</h2>
  <p>The transcript is written in the <strong>native script</strong> of the language spoken (Kannada, Tamil, Gujarati, Hindi, etc.). English words spoken during the call remain in English.</p>
  <p>Each speaker turn is on its own line. Timing and audio events are embedded inline using square brackets:</p>
  <table>
    <thead><tr><th>Notation</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td><code>[]</code></td><td>Normal gap between words at conversational pace</td></tr>
      <tr><td><code>[0.8s]</code> <code>[3.2s]</code></td><td>Measured pause — duration in seconds</td></tr>
      <tr><td><code>[inaudible]</code></td><td>Speech present but not clear enough to transcribe</td></tr>
      <tr><td><code>[interrupted]</code></td><td>Speaker was cut off mid-sentence</td></tr>
      <tr><td><code>[background noise]</code> <code>[traffic]</code> <code>[doorbell]</code></td><td>Environmental sounds heard on the call</td></tr>
      <tr><td><code>[laughter]</code> <code>[cough]</code> <code>[breath]</code></td><td>Human non-speech sounds</td></tr>
      <tr><td><code>[static]</code> <code>[call drops briefly]</code></td><td>Call quality events</td></tr>
    </tbody>
  </table>
  <pre><span class="comment"># Example output (Kannada call)</span>
<span class="key">NEHA:</span> ಹಲೋ[][1.5s]
<span class="key">Akash N Yadav:</span> ಹಲೋ[1.2s]
<span class="key">NEHA:</span> ನಾನು[]Local[]Jobs[]App[]ನಿಂದ[]NEHA[]ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ[0.6s]ನಾನು[]Akash[]ಅವರ[]ಜೊತೆ[]ಮಾತನಾಡುತ್ತಿದ್ದೀನಾ?[2.1s]
<span class="key">Akash N Yadav:</span> [background noise][1.8s]ಹೌದು[3.2s]</pre>

  <hr class="divider" />
  <h2>Errors</h2>
  <table>
    <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
    <tbody>
      <tr><td>400</td><td>Missing hunar_api_key or call_id</td></tr>
      <tr><td>401</td><td>Hunar API key rejected</td></tr>
      <tr><td>404</td><td>Call not found</td></tr>
      <tr><td>422</td><td>Call not COMPLETED, no recording, or under 10 seconds</td></tr>
      <tr><td>502</td><td>Upstream error from Hunar or Gemini</td></tr>
    </tbody>
  </table>
  <hr class="divider" />
  <div class="warning"><strong>Always call this from a backend.</strong> Never expose your Hunar API key in client-side code.</div>
</div>
</body>
</html>`;
}

// --- Types ---

interface HunarCall {
  id: string;
  callee_name: string;
  agent_id: string;
  language: string;
  status: string;
  recording_url: string | null;
  duration_minutes: number;
  triggered_by: string | null;
}

interface HunarAgent {
  id: string;
  name: string;
  persona_name: string;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
  };
}

interface RequestRow {
  id: number;
  timestamp: string;
  client_id: string | null;
  client_email: string | null;
  call_id: string | null;
  callee_name: string | null;
  agent_name: string | null;
  language: string | null;
  duration_seconds: number | null;
  success: number;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  model: string | null;
  cost_usd: number | null;
  transcript: string | null;
}
