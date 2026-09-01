// Assembly replay — "how this review assembled."
// Replays the workspace's op history into a stylized mini-board: cards land
// colored by who placed them (agent / demo / human), notes tick up, artifacts
// appear — with a scrubber to any moment and play/pause. Pure client-side;
// the op log it replays is already persisted in workspace state.

import * as store from '../state.js';

let dialog = null;
let timer = null;

const CLS = { 'browser-agent': 'p-agent', 'demo-agent': 'p-demo-agent', human: 'p-human', remote: 'p-agent', anon: 'p-agent' };
const actorLabel = (a) => (a === 'human' ? 'you' : a === 'demo-agent' ? 'demo agent' : a?.startsWith('w-') || a === 'remote' || a === 'anon' ? 'an agent' : a);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

// Apply ops[0..i] to a fresh mini-model — pure, mirrors applyOne's semantics.
function modelAt(ops, i) {
  const model = {
    title: 'Untitled survey',
    sections: [{ id: 'sec_toread', title: 'To Read' }, { id: 'sec_reading', title: 'Reading' }, { id: 'sec_synth', title: 'Synthesized' }],
    papers: new Map(), // id → { title, sectionId, actor }
    notes: new Map(),  // paperId → count
    artifacts: [],     // { title, kind, actor }
    lastQuery: null,
  };
  for (const op of ops.slice(0, i + 1)) {
    const p = op.payload ?? {};
    const who = CLS[op.actor] ? op.actor : 'remote';
    switch (op.kind) {
      case 'title.set': model.title = String(p.title ?? model.title).slice(0, 120); break;
      case 'section.add':
        if (!model.sections.find((s) => s.id === p.section?.id)) model.sections.push({ id: p.section?.id, title: p.section?.title ?? '?' });
        break;
      case 'section.rename': {
        const s = model.sections.find((x) => x.id === p.sectionId);
        if (s) s.title = String(p.title ?? s.title);
        break;
      }
      case 'paper.add':
        if (/^W\d+$/.test(String(p.paper?.id)) && !model.papers.has(p.paper.id)) {
          model.papers.set(p.paper.id, { title: p.paper.title, sectionId: p.paper.sectionId ?? model.sections[0].id, actor: who });
        }
        break;
      case 'paper.move': {
        const card = model.papers.get(p.paperId);
        if (card && model.sections.find((s) => s.id === p.sectionId)) card.sectionId = p.sectionId;
        break;
      }
      case 'paper.remove': model.papers.delete(p.paperId); break;
      case 'note.add': model.notes.set(p.paperId, (model.notes.get(p.paperId) ?? 0) + 1); break;
      case 'note.delete': model.notes.set(p.paperId, Math.max(0, (model.notes.get(p.paperId) ?? 1) - 1)); break;
      case 'artifact.add':
        if (!model.artifacts.find((a) => a.id === p.artifact?.id)) {
          model.artifacts.push({ id: p.artifact?.id, title: p.artifact?.title, kind: p.artifact?.kind, actor: who });
        }
        break;
      case 'artifact.update': {
        const a = model.artifacts.find((x) => x.id === p.artifactId);
        if (a && p.title) a.title = p.title;
        break;
      }
      case 'artifact.delete': model.artifacts = model.artifacts.filter((x) => x.id !== p.artifactId); break;
      case 'inbox.set': model.lastQuery = p.query ?? model.lastQuery; break;
      default: break;
    }
  }
  return model;
}

function describe(op) {
  const p = op.payload ?? {};
  switch (op.kind) {
    case 'title.set': return `renamed the survey to “${clip(p.title, 40)}”`;
    case 'section.add': return `added a section “${clip(p.section?.title, 30)}”`;
    case 'section.rename': return `renamed a section to “${clip(p.title, 30)}”`;
    case 'paper.add': return `placed “${clip(p.paper?.title, 46)}”`;
    case 'paper.move': return `moved “${clip(modelTitle(p.paperId), 40)}”`;
    case 'paper.remove': return `removed a paper`;
    case 'note.add': return `wrote a ${p.note?.type ?? ''} note`;
    case 'note.delete': return `deleted a note`;
    case 'artifact.add': return `published ${p.artifact?.kind ?? 'an'}: “${clip(p.artifact?.title, 40)}”`;
    case 'artifact.update': return `revised “${clip(p.title, 40)}”`;
    case 'artifact.delete': return `deleted an artifact`;
    case 'inbox.set': return `staged search results${p.query ? `: “${clip(p.query, 40)}”` : ''}`;
    default: return op.kind;
  }
  function modelTitle(paperId) {
    return currentModel?.papers?.get?.(paperId)?.title ?? paperId ?? 'a paper';
  }
}

let currentModel = null;
let currentOps = [];
let cursor = 0;

function renderAt(i) {
  cursor = i;
  currentModel = modelAt(currentOps, i);
  const op = currentOps[i];
  const board = dialog.querySelector('#replay-board');
  const cols = currentModel.sections.map((s) => {
    const cards = [...currentModel.papers.entries()]
      .filter(([, c]) => c.sectionId === s.id)
      .map(([id, c]) => `
        <div class="rp-card ${CLS[c.actor] ?? ''}">
          <span class="rp-dot ${CLS[c.actor] ?? ''}"></span>
          <span class="rp-title">${esc(clip(c.title, 60))}</span>
          ${currentModel.notes.get(id) ? `<span class="rp-notes">✎ ${currentModel.notes.get(id)}</span>` : ''}
        </div>`)
      .join('');
    return `
      <div class="rp-col">
        <div class="rp-col-title">${esc(s.title)}</div>
        ${cards || '<div class="rp-empty">—</div>'}
      </div>`;
  }).join('');
  const arts = currentModel.artifacts.map((a) => `
    <div class="rp-art ${CLS[a.actor] ?? ''}">
      <span class="rp-kind">${esc(a.kind)}</span> ${esc(clip(a.title, 44))}
    </div>`).join('');
  board.innerHTML = `
    <div class="rp-title-line">${esc(currentModel.title)}</div>
    <div class="rp-cols">${cols}</div>
    ${currentModel.artifacts.length ? `<div class="rp-arts">${arts}</div>` : ''}
    <div class="rp-now">
      <span class="rp-dot ${CLS[op?.actor] ?? ''}"></span>
      <span><strong>${esc(actorLabel(op?.actor))}</strong> ${esc(describe(op))}</span>
      <span class="rp-step">${i + 1} / ${currentOps.length}</span>
    </div>`;
  dialog.querySelector('#replay-range').value = String(i);
}

function play() {
  const btn = dialog.querySelector('#replay-play');
  if (timer) {
    clearInterval(timer); timer = null;
    btn.textContent = '▶ play';
    return;
  }
  if (cursor >= currentOps.length - 1) renderAt(0);
  btn.textContent = '❚❚ pause';
  timer = setInterval(() => {
    if (cursor >= currentOps.length - 1) {
      clearInterval(timer); timer = null;
      btn.textContent = '▶ play';
      return;
    }
    renderAt(cursor + 1);
  }, 420);
}

export function openReplay() {
  currentOps = (store.getState().opsHistory ?? []).filter((o) => o && o.payload);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'replay-dialog';
    document.body.appendChild(dialog);
  }
  if (currentOps.length < 1) {
    dialog.innerHTML = `
      <div class="demo-head"><h2>Replay</h2>
      <button class="icon-btn" id="replay-close">✕</button></div>
      <p class="rp-hint">No assembly history yet — this workspace has no recorded ops.</p>`;
  } else {
    dialog.innerHTML = `
      <div class="demo-head">
        <h2>How this review assembled <span class="hint">— replayed from the op log</span></h2>
        <button class="icon-btn" id="replay-close">✕</button>
      </div>
      <div class="rp-controls">
        <button class="btn btn-primary btn-xs" id="replay-play">▶ play</button>
        <input id="replay-range" type="range" min="0" max="${currentOps.length - 1}" value="0" />
        <span class="rp-legend">
          <span class="rp-dot p-agent"></span> agent
          <span class="rp-dot p-demo-agent"></span> demo
          <span class="rp-dot p-human"></span> you
        </span>
      </div>
      <div id="replay-board"></div>`;
    dialog.querySelector('#replay-range').addEventListener('input', (e) => {
      if (timer) { clearInterval(timer); timer = null; dialog.querySelector('#replay-play').textContent = '▶ play'; }
      renderAt(Number(e.target.value));
    });
    dialog.querySelector('#replay-play').addEventListener('click', play);
    renderAt(currentOps.length - 1);
    // start paused at the end so the scrubber invites interaction; autoplay
    // from empty reads better — begin playback immediately
    cursor = -1;
    play();
  }
  dialog.querySelector('#replay-close').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; }
    dialog.close();
  });
  dialog.showModal();
}
