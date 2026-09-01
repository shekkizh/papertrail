// Local mock of the /api/sync contract (same routes, same semantics) plus
// static file serving — lets the two-window live test run without DATABASE_URL.
//   node tools/mock-server.mjs [port]     (default 8348)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.argv[2] ?? 8348);
const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.md': 'text/markdown',
};

const workspaces = new Map(); // id → { title, snapshot, ops: Map<seq, op>, nextSeq, actors: Map<actor, lastSeen> }
const shortId = () => Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');

const KINDS = new Set([
  'title.set', 'section.add', 'section.rename',
  'paper.add', 'paper.move', 'paper.remove',
  'note.add', 'note.delete',
  'artifact.add', 'artifact.update', 'artifact.delete',
  'inbox.set',
]);

function peersOf(ws) {
  const now = Date.now();
  for (const [a, t] of ws.actors) if (now - t > 15000) ws.actors.delete(a);
  return ws.actors.size;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

async function api(req, res, url) {
  const action = url.searchParams.get('action');
  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });

  if (req.method === 'POST' && action === 'create') {
    const id = shortId();
    workspaces.set(id, { title: String(body.title ?? ''), snapshot: body.snapshot ?? {}, ops: new Map(), nextSeq: 1, actors: new Map() });
    return json(res, 200, { id });
  }

  const id = req.method === 'GET' ? url.searchParams.get('id') : String(body.id ?? '');
  const ws = workspaces.get(id);
  if (!ws) return json(res, 404, { error: 'No such live workspace.' });

  if (req.method === 'GET' && action === 'join') {
    const seq = ws.ops.size ? Math.max(...ws.ops.keys()) : 0;
    ws.actors.set(body.actor ?? url.searchParams.get('actor') ?? 'anon', Date.now());
    return json(res, 200, { snapshot: ws.snapshot, title: ws.title, seq, peers: peersOf(ws) });
  }

  if (req.method === 'POST' && action === 'sync') {
    const since = Math.max(0, Math.floor(+body.since || 0));
    const actor = String(body.actor ?? 'anon').slice(0, 40);
    let maxSent = since;
    for (const op of (Array.isArray(body.ops) ? body.ops : []).slice(0, 50)) {
      if (!KINDS.has(op.kind) || !op.payload) continue;
      ws.ops.set(ws.nextSeq, { kind: op.kind, payload: op.payload, actor, ts: Math.floor(+op.ts || Date.now()) });
      maxSent = Math.max(maxSent, ws.nextSeq);
      ws.nextSeq += 1;
    }
    ws.actors.set(actor, Date.now());
    const remote = [...ws.ops.entries()]
      .filter(([seq, op]) => seq > since && op.actor !== actor)
      .sort((a, b) => a[0] - b[0])
      .slice(0, 200)
      .map(([seq, op]) => ({ seq, ...op }));
    return json(res, 200, { ops: remote, seq: Math.max(maxSent, ...remote.map((r) => r.seq), since), peers: peersOf(ws) });
  }

  json(res, 400, { error: 'Unknown action.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  try {
    const path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path === '/' ? 'index.html' : path;
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => console.log(`mock sync server on http://localhost:${PORT}`));
