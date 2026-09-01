// PaperTrail workspace state — DOM-free so it runs in Node tests and the browser.
// Every mutation accepts a `meta` = { callId, source } so agent-written content
// keeps provenance ("receipts") pointing at the exact tool call that produced it.

const STORAGE_KEY = 'papertrail.workspace.v1';

let state = null;
let readOnly = false;          // share-link mode: view a snapshot without owning it
const uiContext = { paperId: null, tab: 'paper' }; // what the human is looking at
const listeners = new Set();
let persistTimer = null;

export function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function defaultState() {
  return {
    title: 'Untitled survey',
    sections: [
      { id: 'sec_toread', title: 'To Read' },
      { id: 'sec_reading', title: 'Reading' },
      { id: 'sec_synth', title: 'Synthesized' },
    ],
    papers: {},          // openalexId -> paper record (with .notes[])
    inbox: [],           // normalized papers staged from searches (agent or human)
    artifacts: [],       // { id, kind: comparison|gaps|draft|summary, title, data:{markdown}, createdBy, callId, createdAt, sources }
    activity: [],        // { id, ts, tool, input, summary, source, ok }
    opsHistory: [],      // { kind, payload, actor, ts } — the assembly story (replay)
    lastQuery: null,
  };
}

const hasLocalStorage = typeof localStorage !== 'undefined';

function sanitizePaper(p) {
  if (!p || typeof p !== 'object' || !/^W\d+$/.test(String(p.id ?? ''))) return null;
  return {
    ...p,
    title: String(p.title ?? 'Untitled'),
    authors: Array.isArray(p.authors) ? p.authors.filter((a) => typeof a === 'string') : [],
    notes: Array.isArray(p.notes) ? p.notes : [],
    citedBy: Number.isFinite(p.citedBy) ? p.citedBy : 0,
    year: Number.isFinite(p.year) ? p.year : null, // rendered un-escaped as text — coerce
  };
}

const SAFE_ID = (prefix) => new RegExp(`^${prefix}[a-z0-9_-]{2,40}$`, 'i');
const SAFE_LABEL = /^[a-z0-9_-]{3,40}$/i;

function sanitizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  return {
    id: SAFE_ID('note_').test(String(n.id)) ? String(n.id) : uid('note'),
    type: NOTE_TYPES.includes(n.type) ? n.type : 'summary',
    content: typeof n.content === 'string' ? n.content.slice(0, 2000) : '',
    createdBy: n.createdBy === 'human' ? 'human' : 'agent',
    callId: typeof n.callId === 'string' && SAFE_ID('call_').test(n.callId) ? n.callId : null,
    sources: Array.isArray(n.sources) ? n.sources.filter((s) => /^W\d+$/.test(String(s))) : [],
    createdAt: Number.isFinite(n.createdAt) ? n.createdAt : Date.now(),
  };
}

const ARTIFACT_KINDS = ['comparison', 'gaps', 'draft', 'summary'];

function sanitizeArtifact(a) {
  if (!a || typeof a !== 'object' || typeof a.data?.markdown !== 'string') return null;
  return {
    id: SAFE_ID('art_').test(String(a.id)) ? String(a.id) : uid('art'),
    kind: ARTIFACT_KINDS.includes(a.kind) ? a.kind : 'summary',
    title: String(a.title ?? 'Untitled').slice(0, 120),
    data: { markdown: a.data.markdown.slice(0, 40000) },
    createdBy: a.createdBy === 'human' ? 'human' : 'agent',
    callId: typeof a.callId === 'string' && SAFE_ID('call_').test(a.callId) ? a.callId : null,
    sources: Array.isArray(a.sources) ? a.sources.filter((s) => /^W\d+$/.test(String(s))) : [],
    revisions: Array.isArray(a.revisions)
      ? a.revisions
          .filter((r) => r && typeof r === 'object')
          .map((r) => ({
            callId: typeof r.callId === 'string' && SAFE_ID('call_').test(r.callId) ? r.callId : null,
            ts: Number.isFinite(r.ts) ? r.ts : Date.now(),
          }))
      : [],
    createdAt: Number.isFinite(a.createdAt) ? a.createdAt : Date.now(),
  };
}

function migrate(s) {
  const d = defaultState();
  const merged = { ...d, ...(typeof s === 'object' && s ? s : {}) };

  // sections: strict id charset — ids are interpolated into DOM attributes
  const seenSectionIds = new Set();
  const sections = (Array.isArray(merged.sections) ? merged.sections : [])
    .map((sec) => ({
      id: typeof sec?.id === 'string' && SAFE_LABEL.test(sec.id) && !seenSectionIds.has(sec.id)
        ? sec.id
        : uid('sec'),
      title: String(sec?.title ?? 'Section').slice(0, 60),
    }))
    .map((sec) => (seenSectionIds.has(sec.id) ? { ...sec, id: uid('sec') } : (seenSectionIds.add(sec.id), sec)));
  merged.sections = sections.length ? sections : d.sections;
  const sectionIds = new Set(merged.sections.map((x) => x.id));

  const papers = {};
  for (const [id, p] of Object.entries(merged.papers ?? {})) {
    if (!/^W\d+$/.test(String(id))) continue;
    const clean = sanitizePaper({ ...p, id });
    if (!clean) continue;
    if (!sectionIds.has(clean.sectionId)) clean.sectionId = merged.sections[0].id;
    clean.notes = (Array.isArray(clean.notes) ? clean.notes : [])
      .map(sanitizeNote)
      .filter(Boolean);
    papers[id] = clean;
  }
  merged.papers = papers;

  merged.inbox = (Array.isArray(merged.inbox) ? merged.inbox : [])
    .map((p) => sanitizePaper({ ...p, id: String(p?.id ?? '') }))
    .filter(Boolean);
  merged.artifacts = (Array.isArray(merged.artifacts) ? merged.artifacts : [])
    .map(sanitizeArtifact)
    .filter(Boolean);
  merged.activity = (Array.isArray(merged.activity) ? merged.activity : [])
    .filter((c) => c && typeof c === 'object' && typeof c.tool === 'string')
    .slice(0, 200)
    .map((c) => ({
      id: SAFE_ID('call_').test(String(c.id)) ? String(c.id) : uid('call'),
      ts: Number.isFinite(c.ts) ? c.ts : Date.now(),
      tool: c.tool.replace(/[^a-z0-9_]/gi, '').slice(0, 60), // interpolated into attributes
      input: c.input && typeof c.input === 'object' ? c.input : {},
      source: ['browser-agent', 'demo-agent', 'human'].includes(c.source) ? c.source : 'browser-agent',
      summary: typeof c.summary === 'string' ? c.summary.slice(0, 300) : null,
      ok: typeof c.ok === 'boolean' ? c.ok : null,
    }));
  merged.opsHistory = (Array.isArray(merged.opsHistory) ? merged.opsHistory : [])
    .filter((o) => o && typeof o === 'object' && typeof o.kind === 'string' && o.payload)
    .slice(-250);
  merged.title = String(merged.title ?? d.title).slice(0, 120);
  merged.lastQuery = typeof merged.lastQuery === 'string' ? merged.lastQuery.slice(0, 200) : null;
  return merged;
}

export function init({ reset = false, fromSnapshot = null } = {}) {
  if (fromSnapshot) {
    state = migrate(fromSnapshot);
    return state;
  }
  if (reset) {
    state = defaultState();
    return state;
  }
  if (state) return state; // already initialized (e.g. from a share link)
  if (hasLocalStorage) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) state = migrate(JSON.parse(raw));
    } catch {
      state = null;
    }
  }
  if (!state) state = defaultState();
  return state;
}

// Live co-watch: two browser windows on the same workspace stay in sync.
// persist() writes localStorage; the `storage` event fires in every OTHER
// tab, so each window re-reads and re-renders on the other's writes —
// human drags and agent tool calls appear on both boards in real time,
// with no backend. Returns an unwire function.
let lastRemoteSnapshot = null; // guard against cross-tab persist echo

export function wireCrossTabSync() {
  if (typeof window === 'undefined' || !hasLocalStorage) return () => {};
  const handler = (e) => {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    try {
      lastRemoteSnapshot = e.newValue;
      state = migrate(JSON.parse(e.newValue));
      emit();
    } catch { /* ignore malformed cross-tab writes */ }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  schedulePersist();
  // isolate listeners: one broken panel must not freeze persist or the others
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[PaperTrail] render error', err); }
  }
}

function persistNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  // a re-persist of a state we just received from another tab would echo
  // between windows instead of converging — skip when content is identical
  if (lastRemoteSnapshot !== null) {
    try {
      if (JSON.stringify(state) === lastRemoteSnapshot) { lastRemoteSnapshot = null; return; }
    } catch { /* fall through and persist */ }
    lastRemoteSnapshot = null;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

function schedulePersist() {
  if (!hasLocalStorage || readOnly) return;
  // background tabs get their timers throttled, which would silently stall
  // cross-tab sync — write through immediately whenever we're not visible
  if (typeof document !== 'undefined' && document.hidden) {
    persistNow();
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && persistTimer) persistNow(); // never lose the tail
  });
}

// ---------- share-link encode/decode ----------

export async function encodeWorkspace() {
  const json = JSON.stringify(state);
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return `gz:${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  }
  return `json:${btoa(unescape(encodeURIComponent(json)))}`;
}

export function decodeWorkspace(encoded) {
  if (encoded.startsWith('gz:')) {
    const b64 = encoded.slice(3).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
      .json();
  }
  if (encoded.startsWith('json:')) {
    return Promise.resolve(JSON.parse(decodeURIComponent(escape(atob(encoded.slice(5))))));
  }
  return Promise.reject(new Error('Unknown share format'));
}

// ---------- share / read-only mode ----------

export function setReadOnly(value) {
  readOnly = Boolean(value);
}

export function isReadOnly() {
  return readOnly;
}

// ---------- what the human is looking at (exposed to agents) ----------

export function setUiContext(ctx) {
  uiContext.paperId = ctx.paperId ?? null;
  uiContext.tab = ctx.tab ?? 'paper';
}

export function getUiContext() {
  return { ...uiContext };
}

// ---------- reads ----------

export function getState() {
  return state;
}

export function getPaper(id) {
  return state.papers[id] ?? null;
}

export function getSectionPapers(sectionId) {
  return allPapers().filter((p) => p.sectionId === sectionId);
}

export function allPapers() {
  return Object.values(state.papers);
}

export function workspaceSnapshot() {
  const sel = getUiContext();
  return {
    title: state.title,
    sections: state.sections.map((s) => ({
      id: s.id,
      title: s.title,
      papers: getSectionPapers(s.id).map((p) => ({
        id: p.id,
        title: p.title,
        year: p.year,
        authors: p.authors.slice(0, 4),
        venue: p.venue,
        citedBy: p.citedBy,
        primaryTopic: p.primaryTopic,
        addedBy: p.addedBy,
        noteCount: p.notes.length,
        noteTypes: p.notes.map((n) => n.type),
      })),
    })),
    artifacts: state.artifacts.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      createdBy: a.createdBy,
      markdownChars: a.data.markdown.length,
    })),
    human_selection: sel.paperId ? { paper_id: sel.paperId, inspector_tab: sel.tab } : null,
    inboxCount: state.inbox.length,
    lastQuery: state.lastQuery,
  };
}

// ---------- live sync: op outbox & remote application ----------
// Every mutation emits an op so a sync transport (js/sync.js) can replicate
// the workspace across devices. Remote application bypasses the outbox, so
// replicated ops never re-broadcast.

let outbox = [];
let applyingRemote = false;
let clientId = 'w-anon';

export function setClientId(id) { clientId = String(id).slice(0, 40); }
export function getClientId() { return clientId; }

export function drainOutbox() {
  const ops = outbox.map((o) => ({ ...o, actor: clientId }));
  outbox = [];
  return ops;
}

// Persistent assembly history: every op (local or replicated) lands here, so
// the workspace remembers HOW it was built — powering the replay scrubber.
// Kept in workspace state, so share snapshots and live joins carry it along.

function pushHistory(kind, payload, actor) {
  if (!Array.isArray(state.opsHistory)) state.opsHistory = [];
  state.opsHistory.push({ kind, payload, actor, ts: Date.now() });
  if (state.opsHistory.length > 250) state.opsHistory = state.opsHistory.slice(-250);
}

function pushOp(kind, payload) {
  if (applyingRemote || readOnly) return;
  outbox.push({ kind, payload, ts: Date.now() });
  pushHistory(kind, payload, clientId);
  if (outbox.length > 100) outbox = outbox.slice(-100);
}

const dedupeById = (list, item) => (list.find((x) => x.id === item.id) ? list : [...list, item]);

function applyOne({ kind, payload }) {
  switch (kind) {
    case 'title.set':
      state.title = String(payload.title ?? '').slice(0, 120);
      break;
    case 'section.add':
      if (!state.sections.find((s) => s.id === payload.section.id)) state.sections.push(payload.section);
      break;
    case 'section.rename': {
      const s = state.sections.find((x) => x.id === payload.sectionId);
      if (s) s.title = String(payload.title ?? s.title).slice(0, 60);
      break;
    }
    case 'paper.add':
      if (/^W\d+$/.test(String(payload.paper?.id)) && !state.papers[payload.paper.id]) {
        state.papers[payload.paper.id] = sanitizePaper(payload.paper) ?? payload.paper;
      }
      break;
    case 'paper.move': {
      const p = state.papers[payload.paperId];
      if (p && state.sections.find((s) => s.id === payload.sectionId)) p.sectionId = payload.sectionId;
      break;
    }
    case 'paper.remove':
      delete state.papers[payload.paperId];
      break;
    case 'note.add': {
      const p = state.papers[payload.paperId];
      if (p) p.notes = dedupeById(p.notes, payload.note);
      break;
    }
    case 'note.delete': {
      const p = state.papers[payload.paperId];
      if (p) p.notes = p.notes.filter((n) => n.id !== payload.noteId);
      break;
    }
    case 'artifact.add':
      if (!state.artifacts.find((a) => a.id === payload.artifact.id)) state.artifacts.unshift(payload.artifact);
      break;
    case 'artifact.update': {
      const a = state.artifacts.find((x) => x.id === payload.artifactId);
      if (a) {
        a.data = { markdown: String(payload.markdown ?? a.data.markdown) };
        if (payload.title) a.title = String(payload.title).slice(0, 120);
        if (Array.isArray(payload.sources)) a.sources = payload.sources;
      }
      break;
    }
    case 'artifact.delete':
      state.artifacts = state.artifacts.filter((a) => a.id !== payload.artifactId);
      break;
    case 'inbox.set':
      state.inbox = (Array.isArray(payload.papers) ? payload.papers : [])
        .map((p) => sanitizePaper({ ...p, id: String(p?.id ?? '') }))
        .filter(Boolean)
        .slice(0, 25);
      if (payload.query) state.lastQuery = String(payload.query).slice(0, 200);
      break;
    default:
      break;
  }
}

let remoteLanded = []; // paper ids touched by remote peers — UI flashes them
let landTimer = null;
export function getRemoteLanded() { return remoteLanded; }

export function applyRemoteOps(ops) {
  applyingRemote = true;
  const touched = [];
  try {
    for (const op of Array.isArray(ops) ? ops : []) {
      applyOne(op);
      if (op.kind === 'paper.add' && op.payload?.paper?.id) touched.push(op.payload.paper.id);
      else if ((op.kind === 'paper.move' || op.kind === 'note.add') && op.payload?.paperId) touched.push(op.payload.paperId);
      // replicated ops are part of the assembly story — record them
      pushHistory(op.kind, op.payload, op.actor ?? 'remote');
    }
  } finally {
    applyingRemote = false;
  }
  if (touched.length) {
    remoteLanded = [...new Set([...remoteLanded, ...touched])];
    clearTimeout(landTimer);
    landTimer = setTimeout(() => { remoteLanded = []; emit(); }, 1600);
  }
  emit();
}

export function applySnapshot(snapshot) {
  state = migrate(snapshot);
  emit();
}

// ---------- activity / provenance ----------

export function recordCall(tool, input, source) {
  if (readOnly) return null; // auditors can verify without mutating the snapshot
  const callId = uid('call');
  state.activity.unshift({
    id: callId,
    ts: Date.now(),
    tool,
    input,
    source,
    summary: null,
    ok: null,
  });
  state.activity = state.activity.slice(0, 200);
  emit();
  return callId;
}

export function completeCall(callId, summary, ok = true) {
  if (!callId || readOnly) return;
  const entry = state.activity.find((a) => a.id === callId);
  if (entry) {
    entry.summary = summary;
    entry.ok = ok;
    emit();
  }
}

export function provenanceOf(callId) {
  return state.activity.find((a) => a.id === callId) ?? null;
}

// ---------- mutations (no-ops in read-only share mode) ----------

export function setTitle(title) {
  if (readOnly) return;
  state.title = String(title).slice(0, 120);
  pushOp('title.set', { title: state.title });
  emit();
}

export function addSection(title) {
  if (readOnly) return null;
  const section = { id: uid('sec'), title: String(title).slice(0, 60) };
  state.sections.push(section);
  pushOp('section.add', { section });
  emit();
  return section;
}

export function renameSection(sectionId, title) {
  if (readOnly) return null;
  const s = state.sections.find((x) => x.id === sectionId);
  if (s) {
    s.title = String(title).slice(0, 60);
    pushOp('section.rename', { sectionId, title: s.title });
    emit();
  }
  return s ?? null;
}

export function normalizePaper(raw) {
  // Accepts an already-normalized paper or an OpenAlex work object.
  if (raw.id && raw.title !== undefined && raw.authors !== undefined) return raw;
  const oa = raw;
  return {
    id: String(oa.id).split('/').pop(),
    doi: oa.doi ?? null,
    title: oa.display_name ?? oa.title ?? 'Untitled',
    authors: (oa.authorships ?? []).map((a) => a.author?.display_name).filter(Boolean),
    year: oa.publication_year ?? null,
    venue: oa.primary_location?.source?.display_name ?? null,
    citedBy: oa.cited_by_count ?? 0,
    type: oa.type ?? null,
    primaryTopic: oa.primary_topic?.display_name ?? null,
    topics: (oa.topics ?? []).map((t) => t.display_name).filter(Boolean),
    oaUrl: oa.open_access?.oa_url ?? null,
    abstract: null,
    referencedWorks: oa.referenced_works ?? null,
    openalexUrl: oa.id ?? null,
  };
}

export function addPaper(paper, { sectionId, addedBy = 'human', callId = null } = {}) {
  if (readOnly) return { paper: null, added: false };
  const norm = normalizePaper(paper);
  const existing = state.papers[norm.id];
  if (existing) {
    if (sectionId && existing.sectionId !== sectionId) existing.sectionId = sectionId;
    emit();
    return { paper: existing, added: false };
  }
  const record = {
    ...norm,
    sectionId: sectionId ?? state.sections[0].id,
    addedAt: Date.now(),
    addedBy,
    addedViaCall: callId,
    notes: [],
  };
  state.papers[record.id] = record;
  pushOp('paper.add', { paper: record });
  emit();
  return { paper: record, added: true };
}

export function movePaper(paperId, sectionId, _meta = {}) {
  if (readOnly) return false;
  const p = state.papers[paperId];
  const s = state.sections.find((x) => x.id === sectionId);
  if (!p || !s) return false;
  p.sectionId = sectionId;
  pushOp('paper.move', { paperId, sectionId });
  emit();
  return true;
}

export function removePaper(paperId, _meta = {}) {
  if (readOnly) return false;
  if (!state.papers[paperId]) return false;
  delete state.papers[paperId];
  pushOp('paper.remove', { paperId });
  emit();
  return true;
}

export const NOTE_TYPES = ['summary', 'method', 'finding', 'limitation', 'connection', 'question'];

export function annotatePaper(paperId, { type, content, createdBy = 'human', callId = null, sources = [] }) {
  if (readOnly) return null;
  const p = state.papers[paperId];
  if (!p) return null;
  const note = {
    id: uid('note'),
    type,
    content,
    createdBy,
    callId,
    sources,
    createdAt: Date.now(),
  };
  p.notes.push(note);
  pushOp('note.add', { paperId, note });
  emit();
  return note;
}

export function deleteNote(paperId, noteId) {
  if (readOnly) return false;
  const p = state.papers[paperId];
  if (!p) return false;
  const before = p.notes.length;
  p.notes = p.notes.filter((n) => n.id !== noteId);
  if (p.notes.length !== before) {
    pushOp('note.delete', { paperId, noteId });
    emit();
    return true;
  }
  return false;
}

export function addArtifact({ kind, title, data, createdBy = 'human', callId = null, sources = [] }) {
  if (readOnly) return null;
  const artifact = {
    id: uid('art'),
    kind,
    title: String(title).slice(0, 120),
    data,
    createdBy,
    callId,
    sources,
    createdAt: Date.now(),
  };
  state.artifacts.unshift(artifact);
  pushOp('artifact.add', { artifact });
  emit();
  return artifact;
}

// Update an artifact in place — the agent's revision path. Returns the updated
// artifact, or null if the id is unknown. Revision provenance appends.
export function updateArtifact(artifactId, { title, markdown, callId = null, sources = null }) {
  if (readOnly) return null;
  const artifact = state.artifacts.find((a) => a.id === artifactId);
  if (!artifact) return null;
  if (title) artifact.title = String(title).slice(0, 120);
  if (typeof markdown === 'string') artifact.data = { markdown };
  if (Array.isArray(sources)) artifact.sources = sources;
  artifact.revisions = artifact.revisions ?? [];
  artifact.revisions.push({ callId, ts: Date.now() });
  artifact.callId = callId ?? artifact.callId;
  pushOp('artifact.update', { artifactId, title: artifact.title, markdown: artifact.data.markdown, sources: artifact.sources });
  emit();
  return artifact;
}

export function deleteArtifact(artifactId) {
  if (readOnly) return false;
  const before = state.artifacts.length;
  state.artifacts = state.artifacts.filter((a) => a.id !== artifactId);
  if (state.artifacts.length !== before) {
    pushOp('artifact.delete', { artifactId });
    emit();
    return true;
  }
  return false;
}

export function setInbox(papers, { query = null } = {}) {
  if (readOnly) return;
  state.inbox = papers.map((p) => normalizePaper(p));
  state.lastQuery = query ?? state.lastQuery;
  pushOp('inbox.set', { papers: state.inbox.slice(0, 25), query: state.lastQuery });
  emit();
}

export function clearInbox() {
  if (readOnly) return;
  state.inbox = [];
  emit();
}

export function resetWorkspace() {
  if (readOnly) return;
  state = defaultState();
  emit();
}
