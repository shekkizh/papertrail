// PaperTrail live sync API — Vercel serverless function over Neon Postgres.
//
//   POST /api/sync?action=create   {title, snapshot}        → {id}
//   GET  /api/sync?action=join&id= → {snapshot, seq, peers}
//   POST /api/sync?action=sync     {id, since, actor, ops}  → {ops, seq, peers}
//
// The op log is the collaboration primitive: every local mutation (human or
// agent tool call) becomes an op; clients apply remote ops idempotently and
// re-broadcast nothing. Capability model: the workspace id is the secret.

import { db, ensureSchema } from './_db.js';

const KINDS = new Set([
  'title.set', 'section.add', 'section.rename',
  'paper.add', 'paper.move', 'paper.remove',
  'note.add', 'note.delete',
  'artifact.add', 'artifact.update', 'artifact.delete',
  'inbox.set',
]);

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function shortId() {
  return Array.from({ length: 10 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 31)]).join('');
}

function validOp(op) {
  return op && typeof op === 'object' &&
    KINDS.has(op.kind) &&
    typeof op.actor === 'string' && op.actor.length <= 40 &&
    op.payload !== undefined && op.payload !== null;
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const url = new URL(req.url, 'http://x');
    const action = url.searchParams.get('action');

    if (req.method === 'POST' && action === 'create') {
      const body = await readBody(req);
      const id = shortId();
      const title = String(body?.title ?? 'Untitled survey').slice(0, 120);
      await db()`INSERT INTO workspaces (id, title, data) VALUES (${id}, ${title}, ${JSON.stringify(body?.snapshot ?? {})})`;
      return json(res, 200, { id });
    }

    if (req.method === 'GET' && action === 'join') {
      const id = url.searchParams.get('id') ?? '';
      const rows = await db()`SELECT title, data FROM workspaces WHERE id = ${id}`;
      if (!rows.length) return json(res, 404, { error: 'No such live workspace.' });
      const seqRows = await db()`SELECT COALESCE(MAX(seq), 0) AS seq FROM ops WHERE workspace_id = ${id}`;
      const peers = await countPeers(id);
      return json(res, 200, { snapshot: rows[0].data, title: rows[0].title, seq: Number(seqRows[0].seq), peers });
    }

    if (req.method === 'POST' && action === 'sync') {
      const body = await readBody(req);
      const id = String(body?.id ?? '');
      const since = Number.isFinite(+body?.since) ? Math.max(0, Math.floor(+body.since)) : 0;
      const actor = String(body?.actor ?? '').slice(0, 40) || 'anon';
      const exists = await db()`SELECT 1 FROM workspaces WHERE id = ${id}`;
      if (!exists.length) return json(res, 404, { error: 'No such live workspace.' });

      const incoming = Array.isArray(body?.ops) ? body.ops.filter(validOp).slice(0, 50) : [];
      let maxSent = since;
      for (const op of incoming) {
        const inserted = await db()`
          INSERT INTO ops (workspace_id, kind, payload, actor, ts)
          VALUES (${id}, ${op.kind}, ${JSON.stringify(op.payload ?? {})}, ${actor}, ${Math.floor(+op.ts || Date.now())})
          RETURNING seq`;
        maxSent = Math.max(maxSent, Number(inserted[0].seq));
      }
      await db()`
        INSERT INTO actors (actor, workspace_id, last_seen) VALUES (${actor}, ${id}, now())
        ON CONFLICT (actor, workspace_id) DO UPDATE SET last_seen = now()`;
      await db()`UPDATE workspaces SET updated_at = now() WHERE id = ${id}`;

      const remote = await db()`
        SELECT seq, kind, payload, actor, ts FROM ops
        WHERE workspace_id = ${id} AND seq > ${since} AND actor <> ${actor}
        ORDER BY seq ASC LIMIT 200`;
      const peers = await countPeers(id);
      return json(res, 200, {
        ops: remote.map((r) => ({ seq: Number(r.seq), kind: r.kind, payload: r.payload, actor: r.actor, ts: Number(r.ts) })),
        seq: Math.max(maxSent, ...(remote.length ? remote.map((r) => Number(r.seq)) : [since])),
        peers,
      });
    }

    return json(res, 400, { error: 'Unknown action.' });
  } catch (err) {
    return json(res, err.statusCode ?? 500, { error: String(err.message ?? err) });
  }
}

async function countPeers(id) {
  const rows = await db()`
    SELECT COUNT(DISTINCT actor)::int AS n FROM actors
    WHERE workspace_id = ${id} AND last_seen > now() - interval '15 seconds'`;
  return Number(rows[0].n);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2_000_000) reject(new Error('Payload too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
