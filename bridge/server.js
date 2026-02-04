import http from 'node:http';

const PORT = Number(process.env.BRIDGE_PORT || 8000);
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/respond') {
    try {
      const json = await readJson(req);
      const text = String(json.text || '').trim();
      const userId = String(json.userId || '');

      // Very simple placeholder logic.
      // Replace this with real OpenClaw agent routing later.
      const reply = text
        ? `Ricevuto${userId ? ` (${userId})` : ''}: ${text}`
        : 'Dimmi pure.';

      const out = JSON.stringify({ reply });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(out)
      });
      res.end(out);
    } catch (err) {
      const out = JSON.stringify({ reply: '' });
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(out)
      });
      res.end(out);
      console.error('[bridge] error', err);
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] listening on http://${HOST}:${PORT}/respond`);
});
