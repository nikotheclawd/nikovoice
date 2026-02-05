import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';

const app = express();
app.use(express.json({ limit: '2mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Rome';

// Bridge backend:
// - openai: direct /v1/chat/completions
// - openclaw: call `openclaw agent` so the reply comes from Niko(OpenClaw)
const BRIDGE_BACKEND = (process.env.BRIDGE_BACKEND || 'openclaw').toLowerCase();

// OpenClaw agent integration
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || 'main';
const OPENCLAW_THINKING = process.env.OPENCLAW_THINKING || 'low';
const OPENCLAW_TIMEOUT = Number(process.env.OPENCLAW_TIMEOUT || 120);
const OPENCLAW_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || ''; // e.g. agent:main:discord:channel:<id>
const OPENCLAW_SESSION_ID = process.env.OPENCLAW_SESSION_ID || ''; // UUID; overrides session key resolution

// Hard allowlist (defense-in-depth; bot already enforces)
const ALLOWLIST = new Set(['323379312608673803', '381895367861600258']);

// Very small rolling memory per user (in-process) (OpenAI backend only)
const memory = new Map();
const MAX_TURNS = Number(process.env.BRIDGE_MAX_TURNS || 8); // user+assistant messages

// Serialize per-user runs to avoid overlapping voice turns
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    key,
    next.catch(() => {
      // don't keep rejected promise as the tail
    })
  );
  return next;
}

let cachedOpenClawSessionId = null;
let cachedOpenClawSessionAt = 0;

function getThread(userId) {
  const key = String(userId || 'unknown');
  if (!memory.has(key)) memory.set(key, []);
  return memory.get(key);
}

function pushMsg(thread, role, content) {
  thread.push({ role, content });
  // keep only last MAX_TURNS*2-ish messages
  const max = MAX_TURNS * 2;
  if (thread.length > max) thread.splice(0, thread.length - max);
}

function nowParts() {
  const now = new Date();
  const hh = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, hour: '2-digit', hour12: false }).format(now);
  const mm = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, minute: '2-digit' }).format(now);
  const dd = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, day: '2-digit' }).format(now);
  const mo = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, month: '2-digit' }).format(now);
  const yy = new Intl.DateTimeFormat('it-IT', { timeZone: TIME_ZONE, year: 'numeric' }).format(now);
  return { hh, mm, dd, mo, yy };
}

function isTimeQuestion(text) {
  return /\b(che\s+ore\s+sono|che\s+ora\s+e\b|che\s+ora\s+è\b|che\s+ore\s+e\b|che\s+ore\s+è\b|mi\s+dici\s+l['’]ora|ora\?|orario)\b/i.test(text);
}

function extractJsonFromOutput(raw) {
  const i = raw.indexOf('{');
  const j = raw.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) throw new Error('No JSON object found in output');
  return JSON.parse(raw.slice(i, j + 1));
}

async function resolveOpenClawSessionId() {
  if (OPENCLAW_SESSION_ID) return OPENCLAW_SESSION_ID;
  if (!OPENCLAW_SESSION_KEY) return '';

  // Cache for a bit to avoid spawning `openclaw sessions list` on every request
  const now = Date.now();
  if (cachedOpenClawSessionId && now - cachedOpenClawSessionAt < 60_000) return cachedOpenClawSessionId;

  const out = await new Promise((resolve, reject) => {
    const p = spawn('openclaw', ['--no-color', 'sessions', 'list', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`openclaw sessions list failed (code=${code}): ${stderr}`));
    });
  });

  const json = extractJsonFromOutput(out);
  const found = (json.sessions || []).find((s) => s.key === OPENCLAW_SESSION_KEY);
  cachedOpenClawSessionId = found?.sessionId || '';
  cachedOpenClawSessionAt = now;
  return cachedOpenClawSessionId;
}

async function runOpenClawAgent({ message, userId, guildId, channelId }) {
  const sessionId = await resolveOpenClawSessionId();

  const wrapped =
    `Modalità VOCE (Discord). Rispondi in italiano, senza markdown, in 1-3 frasi. ` +
    `Se non capisci bene, chiedi di ripetere dicendo cosa hai capito.\n\n` +
    `Utente(${userId}) in VC(${guildId}/${channelId}): ${message}`;

  const args = ['--no-color', 'agent', '--agent', OPENCLAW_AGENT_ID, '--thinking', OPENCLAW_THINKING, '--json', '--timeout', String(OPENCLAW_TIMEOUT), '--message', wrapped];
  if (sessionId) args.splice(2, 0, '--session-id', sessionId);

  const out = await new Promise((resolve, reject) => {
    const p = spawn('openclaw', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`openclaw agent failed (code=${code}): ${stderr}`));
    });
  });

  const json = extractJsonFromOutput(out);
  const payloads = json?.result?.payloads || [];
  const reply = (payloads[0]?.text || '').trim();
  return reply;
}

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/respond', async (req, res) => {
  try {
    const { text, userId, guildId, channelId } = req.body || {};

    if (!ALLOWLIST.has(String(userId))) {
      return res.status(403).json({ reply: '' });
    }

    const cleaned = String(text || '').trim();
    if (!cleaned) return res.json({ reply: '' });

    // backend-specific auth checks below

    // Cheap fast-path for time questions (no LLM, no tokens)
    if (isTimeQuestion(cleaned)) {
      const { hh, mm } = nowParts();
      return res.json({ reply: `Sono le ${hh}:${mm}.` });
    }

    const queueKey = String(userId);

    const reply = await enqueue(queueKey, async () => {
      if (BRIDGE_BACKEND === 'openclaw') {
        return runOpenClawAgent({ message: cleaned, userId, guildId, channelId });
      }

      // --- OpenAI backend (legacy) ---
      if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY mancante sul bridge (backend=openai).');
      }

      const thread = getThread(userId);

      const { hh, mm, dd, mo, yy } = nowParts();
      const system = {
        role: 'system',
        content:
          "Sei NikoVoice, un assistente vocale in Discord. Rispondi SEMPRE e SOLO in italiano, in modo naturale e conciso. " +
          "Se non capisci bene l'audio o la frase è nonsense, chiedi di ripetere e ripeti brevemente cosa hai capito. " +
          "Non leggere ad alta voce numeri lunghi o ID; se servono, riassumi. " +
          `Ora corrente (timezone ${TIME_ZONE}): ${hh}:${mm} del ${dd}/${mo}/${yy}.`
      };

      pushMsg(thread, 'user', cleaned);

      const body = {
        model: CHAT_MODEL,
        messages: [system, ...thread],
        temperature: 0.6,
        max_tokens: 220
      };

      const r = await fetch(`${OPENAI_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!r.ok) {
        const t = await r.text();
        console.error('bridge chat error', r.status, t);
        throw new Error('Errore temporaneo nel generare la risposta.');
      }

      const json = await r.json();
      const rText = (json.choices?.[0]?.message?.content || '').trim();

      if (rText) pushMsg(thread, 'assistant', rText);
      return rText;
    });

    res.json({ reply: reply || '' });
  } catch (err) {
    console.error('bridge /respond error', err);
    res.status(500).json({ reply: 'Errore interno bridge.' });
  }
});

const host = process.env.BRIDGE_HOST || '127.0.0.1';
const port = Number(process.env.BRIDGE_PORT || 8000);

app.listen(port, host, () => {
  console.log(`bridge listening on http://${host}:${port}`);
});
