import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
const TIME_ZONE = process.env.TIME_ZONE || 'Europe/Rome';

// Hard allowlist (defense-in-depth; bot already enforces)
const ALLOWLIST = new Set(['323379312608673803', '381895367861600258']);

// Very small rolling memory per user (in-process)
const memory = new Map();
const MAX_TURNS = Number(process.env.BRIDGE_MAX_TURNS || 8); // user+assistant messages

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

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ reply: 'Errore: OPENAI_API_KEY mancante sul bridge.' });
    }

    // Cheap fast-path for time questions (no LLM, no tokens)
    if (isTimeQuestion(cleaned)) {
      const { hh, mm } = nowParts();
      return res.json({ reply: `Sono le ${hh}:${mm}.` });
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
      return res.status(500).json({ reply: 'Errore temporaneo nel generare la risposta.' });
    }

    const json = await r.json();
    const reply = (json.choices?.[0]?.message?.content || '').trim();

    if (reply) pushMsg(thread, 'assistant', reply);

    res.json({ reply });
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
