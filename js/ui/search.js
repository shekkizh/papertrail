// Left rail: literature search (human path), the shared Inbox (agent + human staging),
// and suggested prompts the human can paste to their agent.

import * as store from '../state.js';
import * as oa from '../openalex.js';
import { select } from './selection.js';

const PROMPTS = [
  'Search for recent papers on my topic and add the 5 most relevant to “To Read”, with a one-line summary note each.',
  'Read the papers in “Reading” and write a finding and a limitation note for each.',
  'Compare the papers in “Reading” across method, benchmarks, and key findings, then publish the table.',
  'What is underexplored in my current corpus? Propose gap hypotheses and a follow-up search for each.',
];

let searchSeq = 0;
let lastYear = '';
let lastStatus = '';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderSearch(container, state) {
  // don't clobber a search the human is typing
  const active = document.activeElement;
  if (active && container.contains(active) &&
      (active.id === 'search-input' || active.id === 'search-year')) {
    return;
  }
  const wasOpen = container.querySelector('#search-input')?.value ?? '';
  lastYear = container.querySelector('#search-year')?.value ?? lastYear;
  lastStatus = container.querySelector('#search-status')?.textContent ?? lastStatus;
  container.innerHTML = `
    <div class="search-block">
      <form id="search-form" class="search-form">
        <input id="search-input" type="search" placeholder="Search 250M+ papers…" autocomplete="off" value="${esc(wasOpen)}" />
        <div class="search-row">
          <label class="year-label">from <input id="search-year" type="number" min="1990" max="2026" placeholder="2019" value="${esc(lastYear)}" /></label>
          <button type="submit" class="btn btn-primary">Search</button>
        </div>
      </form>
      <div id="search-status" class="search-status" ${lastStatus ? '' : 'hidden'}>${esc(lastStatus)}</div>
    </div>

    <div class="inbox-block">
      <div class="block-head">
        <h3>Inbox <span class="hint">— staged by you or your agent</span></h3>
        <button id="inbox-clear" class="btn btn-ghost btn-xs" ${state.inbox.length ? '' : 'hidden'}>clear</button>
      </div>
      ${state.lastQuery ? `<p class="inbox-query">latest: “${esc(state.lastQuery)}”</p>` : ''}
      <div id="inbox-list" class="inbox-list"></div>
      <div id="inbox-empty" class="empty small" ${state.inbox.length ? 'hidden' : ''}>
        Search results land here — whether you searched or your agent did.
      </div>
    </div>

    <div class="prompts-block">
      <div class="block-head"><h3>Ask your agent</h3></div>
      <p class="hint pad-x">With WebMCP, paste a prompt into your agent's chat — it will discover this app's tools on its own.</p>
      <div class="prompt-list">
        ${PROMPTS.map((p, i) => `
          <button class="prompt-chip" data-i="${i}" title="Click to copy">
            <span>${esc(p)}</span><span class="copy-glyph">⧉</span>
          </button>`).join('')}
      </div>
    </div>`;

  const form = container.querySelector('#search-form');
  const status = container.querySelector('#search-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = container.querySelector('#search-input').value.trim();
    if (!q) return;
    const fromYear = parseInt(container.querySelector('#search-year').value, 10) || null;
    const seq = ++searchSeq;
    lastStatus = 'Searching OpenAlex…';
    status.hidden = false;
    status.textContent = lastStatus;
    try {
      const results = await oa.searchWorks(q, { perPage: 10, fromYear });
      if (seq !== searchSeq) return; // a newer search superseded this one
      store.setInbox(results, { query: q });
      lastStatus = '';
      status.hidden = true;
    } catch (err) {
      if (seq === searchSeq) {
        lastStatus = `Search failed: ${err.message}`;
        status.textContent = lastStatus;
      }
    }
  });

  const inbox = container.querySelector('#inbox-list');
  for (const p of state.inbox) {
    const item = document.createElement('div');
    item.className = 'inbox-item';
    item.innerHTML = `
      <div class="inbox-main">
        <span class="inbox-title" title="${esc(p.title)}">${esc(p.title)}</span>
        <span class="inbox-meta">${esc(p.authors.slice(0, 1).join(''))}${p.authors.length ? ' ·' : ''} ${p.year ?? 'n.d.'} · ${p.citedBy} cites</span>
      </div>
      <div class="inbox-actions">
        <button class="btn btn-ghost btn-xs" data-details="${p.id}" title="Open details">info</button>
        <button class="btn btn-primary btn-xs" data-add="${p.id}">＋ add</button>
      </div>`;
    inbox.appendChild(item);
  }
  container.querySelector('#inbox-clear').hidden = !state.inbox.length;

  inbox.addEventListener('click', (e) => {
    const addId = e.target.dataset.add;
    const infoId = e.target.dataset.details;
    if (addId) store.addPaper(store.getState().inbox.find((p) => p.id === addId), { addedBy: 'human' });
    else if (infoId) select(infoId);
  });
  container.querySelector('#inbox-clear')?.addEventListener('click', () => store.clearInbox());

  container.querySelectorAll('.prompt-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const text = PROMPTS[Number(chip.dataset.i)];
      try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked */ }
      chip.classList.add('copied');
      chip.querySelector('.copy-glyph').textContent = '✓ copied';
      setTimeout(() => {
        chip.classList.remove('copied');
        chip.querySelector('.copy-glyph').textContent = '⧉';
      }, 1200);
    });
  });
}
