// Live sync client — replicates the workspace across devices through
// api/sync.js. Local-first: everything works offline exactly as before;
// going live adds an op-log exchange (drain local ops → apply remote ops)
// on a visibility-aware poll. The workspace id is the capability.

import * as store from './state.js';

const API = '/api/sync';

// stable per-tab actor id — survives reloads so presence counts stay honest
const actor = (() => {
  try {
    const existing = sessionStorage.getItem('papertrail.actor');
    if (existing) return existing;
    const fresh = `w-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
    sessionStorage.setItem('papertrail.actor', fresh);
    return fresh;
  } catch {
    return `w-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  }
})();
store.setClientId(actor);

// The live workspace this tab participates in (null = local-only).
export let currentId = null;
export function setCurrentId(id) { currentId = id; }

async function api(action, body, method = 'POST') {
  const url = action === 'join' ? `${API}?action=join&id=${encodeURIComponent(body.id)}` : `${API}?action=${action}`;
  const res = await fetch(url, method === 'GET'
    ? { headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `sync ${res.status}`);
  return data;
}

// Create a live workspace from the current local state.
export async function createLive() {
  const snapshot = JSON.parse(JSON.stringify(store.getState()));
  store.drainOutbox(); // the snapshot carries everything; drop redundant ops
  const { id } = await api('create', { title: snapshot.title, snapshot });
  return { id, actor };
}

// Join an existing live workspace: replace local state with the cloud snapshot.
export async function joinLive(id) {
  const { snapshot, seq, peers } = await api('join', { id }, 'GET');
  store.applySnapshot(snapshot);
  return { seq, peers, actor };
}

// Start the sync loop. Returns a stop function.
export function startSync(id, onStatus, { visibleMs = 1200, hiddenMs = 5000 } = {}) {
  let since = 0;
  let stopped = false;
  let timer = null;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const ops = store.drainOutbox();
    try {
      const data = await api('sync', { id, since, actor, ops });
      since = Number(data.seq ?? since);
      if (data.ops?.length) store.applyRemoteOps(data.ops);
      onStatus({ ok: true, peers: Number(data.peers ?? 1), queued: ops.length });
      timer = setTimeout(tick, document.hidden ? hiddenMs : visibleMs);
    } catch (err) {
      // keep local ops queued — they post on the next successful tick
      onStatus({ ok: false, error: String(err.message ?? err), queued: ops.length });
      timer = setTimeout(tick, 3000);
    } finally {
      inFlight = false;
    }
  };
  tick();
  return () => { stopped = true; clearTimeout(timer); };
}
