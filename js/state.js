// PaperTrail workspace state — DOM-free so it runs in Node tests and the browser.
// Every mutation accepts a `meta` = { callId, source } so agent-written content
// keeps provenance ("receipts") pointing at the exact tool call that produced it.

const STORAGE_KEY = 'papertrail.workspace.v1';

let state = null;
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
    artifacts: [],       // { id, kind: comparison|gaps|draft, title, data, createdBy, callId, createdAt }
    activity: [],        // { id, ts, tool, input, summary, source, ok }
  };
}

const hasLocalStorage = typeof localStorage !== 'undefined';

export function init({ reset = false } = {}) {
  if (!reset && hasLocalStorage) {
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

function migrate(s) {
  const d = defaultState();
  return { ...d, ...s, papers: s.papers ?? {}, activity: s.activity ?? [] };
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  schedulePersist();
  for (const fn of listeners) fn(state);
}

function schedulePersist() {
  if (!hasLocalStorage) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
  }, 250);
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
    artifactCount: state.artifacts.length,
    artifactTitles: state.artifacts.map((a) => a.title),
    inboxCount: state.inbox.length,
  };
}

// ---------- activity / provenance ----------

export function recordCall(tool, input, source) {
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

// ---------- mutations ----------

export function setTitle(title) {
  state.title = title;
  emit();
}

export function addSection(title) {
  const section = { id: uid('sec'), title };
  state.sections.push(section);
  emit();
  return section;
}

export function renameSection(sectionId, title) {
  const s = state.sections.find((x) => x.id === sectionId);
  if (s) { s.title = title; emit(); }
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
  emit();
  return { paper: record, added: true };
}

export function movePaper(paperId, sectionId, _meta = {}) {
  const p = state.papers[paperId];
  const s = state.sections.find((x) => x.id === sectionId);
  if (!p || !s) return false;
  p.sectionId = sectionId;
  emit();
  return true;
}

export function removePaper(paperId, _meta = {}) {
  if (!state.papers[paperId]) return false;
  delete state.papers[paperId];
  emit();
  return true;
}

export const NOTE_TYPES = ['summary', 'method', 'finding', 'limitation', 'connection', 'question'];

export function annotatePaper(paperId, { type, content, createdBy = 'human', callId = null, sources = [] }) {
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
  emit();
  return note;
}

export function deleteNote(paperId, noteId) {
  const p = state.papers[paperId];
  if (!p) return false;
  const before = p.notes.length;
  p.notes = p.notes.filter((n) => n.id !== noteId);
  if (p.notes.length !== before) { emit(); return true; }
  return false;
}

export function addArtifact({ kind, title, data, createdBy = 'human', callId = null, sources = [] }) {
  const artifact = {
    id: uid('art'),
    kind,
    title,
    data,
    createdBy,
    callId,
    sources,
    createdAt: Date.now(),
  };
  state.artifacts.unshift(artifact);
  emit();
  return artifact;
}

export function deleteArtifact(artifactId) {
  const before = state.artifacts.length;
  state.artifacts = state.artifacts.filter((a) => a.id !== artifactId);
  if (state.artifacts.length !== before) { emit(); return true; }
  return false;
}

export function setInbox(papers) {
  state.inbox = papers.map((p) => normalizePaper(p));
  emit();
}

export function clearInbox() {
  state.inbox = [];
  emit();
}

export function resetWorkspace() {
  state = defaultState();
  emit();
}
