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

function paperCard(p) {
  const who = WHO[p.addedBy] ?? WHO.human;
  const card = el(`
    <article class="card" draggable="true" data-id="${p.id}" title="${p.title.replace(/"/g, '&quot;')}">
      <button class="card-x" title="Remove from workspace" data-remove="${p.id}">✕</button>
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
    if (e.target.dataset.remove) return;
    select(p.id);
  });
  card.addEventListener('dragstart', () => { dragId = p.id; card.classList.add('dragging'); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

function trim(s, n) { return s.length > n ? `${s.slice(0, n - 1)}…` : s; }
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function column(section, papers) {
  const col = el(`
    <div class="column" data-section="${section.id}">
      <header class="col-head">
        <h3 class="col-title" contenteditable="spellcheck-false" title="Click to rename">${escapeHtml(section.title)}</h3>
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
    if (dragId) store.movePaper(dragId, section.id);
    dragId = null;
  });

  col.querySelector('.card-x')?.addEventListener('click', (e) => {
    store.removePaper(e.target.dataset.remove);
  });
  col.querySelector('[data-remove]')?.addEventListener('click', (e) => {
    store.removePaper(e.target.dataset.remove);
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
  container.innerHTML = '';
  const sel = getSelection();
  for (const section of state.sections) {
    const papers = store.getSectionPapers(section.id);
    const col = column(section, papers);
    if (papers.some((p) => p.id === sel.paperId)) col.querySelector('.card[data-id]');
    container.appendChild(col);
    const selected = col.querySelector(`.card[data-id="${sel.paperId}"]`);
    if (selected) selected.classList.add('selected');
  }
  const add = el(`<button class="add-section" title="New section">＋ section</button>`);
  add.addEventListener('click', () => store.addSection('New section'));
  container.appendChild(add);
}
