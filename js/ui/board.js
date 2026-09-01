// The canvas: sections as columns, papers as cards. Drag between sections (human),
// click to inspect. Agent moves/adds render here through the same state store.

import * as store from '../state.js';
import { select, getSelection } from './selection.js';

const WHO = {
  human: { cls: 'who-human', label: 'added by you', text: 'you' },
  agent: { cls: 'who-agent', label: 'added by your agent', text: 'agent' },
};

let dragId = null;

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trim(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function paperCard(p) {
  const who = WHO[p.addedBy] ?? WHO.human;
  const selected = getSelection().paperId === p.id;
  const card = el(`
    <article class="card ${selected ? 'selected' : ''}" draggable="true" data-id="${p.id}" title="${escapeHtml(p.title)}">
      <button class="card-x" title="Remove from workspace" aria-label="Remove ${escapeHtml(trim(p.title, 40))}">✕</button>
      <h4 class="card-title">${escapeHtml(p.title)}</h4>
      <p class="card-meta">${escapeHtml(p.authors.slice(0, 2).join(', '))}${p.authors.length > 2 ? ' et al.' : ''} · ${p.year ?? 'n.d.'}</p>
      <p class="card-meta dim">${escapeHtml(p.venue ?? '')}</p>
      <div class="card-chips">
        <span class="who ${who.cls}" title="${who.label}">${who.text}</span>
        ${p.primaryTopic ? `<span class="chip">${escapeHtml(trim(p.primaryTopic, 34))}</span>` : ''}
        <span class="chip chip-cite">${p.citedBy} cites</span>
        ${p.notes.length ? `<span class="chip chip-notes">✎ ${p.notes.length}</span>` : ''}
      </div>
    </article>`);
  card.addEventListener('click', (e) => {
    if (e.target.classList.contains('card-x')) {
      store.removePaper(p.id);
      if (getSelection().paperId === p.id) select(null);
      return;
    }
    select(p.id);
  });
  card.addEventListener('dragstart', () => { dragId = p.id; card.classList.add('dragging'); });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragId = null; // also covers cancelled/escaped drags
  });
  return card;
}

function column(section, papers) {
  const col = el(`
    <div class="column" data-section="${section.id}">
      <header class="col-head">
        <h3 class="col-title" contenteditable="plaintext-only" spellcheck="false" title="Click to rename">${escapeHtml(section.title)}</h3>
        <span class="col-count">${papers.length}</span>
      </header>
      <div class="col-body"></div>
      <footer class="col-foot">drop papers here</footer>
    </div>`);
  const body = col.querySelector('.col-body');
  for (const p of papers) body.appendChild(paperCard(p));

  body.addEventListener('dragover', (e) => { e.preventDefault(); body.classList.add('over'); });
  body.addEventListener('dragleave', () => body.classList.remove('over'));
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('over');
    // validate against current state — a mid-drag agent render can invalidate the id
    if (dragId && store.getPaper(dragId)) store.movePaper(dragId, section.id);
    dragId = null;
  });

  const title = col.querySelector('.col-title');
  title.addEventListener('blur', () => {
    const v = title.textContent.trim();
    if (v && v !== section.title) store.renameSection(section.id, v);
    else title.textContent = section.title;
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
  });
  return col;
}

export function renderBoard(container, state) {
  // don't clobber in-progress human edits (renaming a section, mid-drag)
  const active = document.activeElement;
  if (active && container.contains(active)) {
    if (active.isContentEditable || active.classList.contains('dragging')) return;
  }
  container.innerHTML = '';
  for (const section of state.sections) {
    container.appendChild(column(section, store.getSectionPapers(section.id)));
  }
  const add = el(`<button class="add-section" title="New section">＋ section</button>`);
  add.addEventListener('click', () => store.addSection('New section'));
  container.appendChild(add);
}
