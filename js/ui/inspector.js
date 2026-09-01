// Right rail: Paper inspector (details, notes, provenance), Artifacts gallery,
// and the Activity log — the full audit trail of every agent tool call.

import * as store from '../state.js';
import { verifySources } from '../tools.js';
import { getSelection, select, setTab } from './selection.js';
import { renderMarkdown } from './markdown.js';

const NOTE_ICON = {
  summary: '§', method: '⚙', finding: '✦', limitation: '⚠', connection: '⇄', question: '?',
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function whoBadge(createdBy) {
  return createdBy === 'human'
    ? '<span class="badge badge-human" title="written by you">✋ you</span>'
    : '<span class="badge badge-agent" title="written by an agent">✦ agent</span>';
}

function provenanceDetails(callId) {
  const call = store.provenanceOf(callId);
  if (!call) return '';
  return `
    <details class="prov">
      <summary>provenance — how this was made</summary>
      <div class="prov-body">
        <div><span class="mono">${esc(call.tool)}</span> via ${call.source === 'demo-agent' ? 'the in-page demo agent' : 'your browser agent'}</div>
        <pre class="prov-pre">${esc(JSON.stringify(call.input, null, 2))}</pre>
        ${call.summary ? `<div class="prov-sum">${esc(call.summary)}</div>` : ''}
        <div class="hint">${timeAgo(call.ts)}</div>
      </div>
    </details>`;
}

function noteView(p, n) {
  const li = document.createElement('div');
  li.className = 'note';
  li.dataset.noteId = n.id;
  const ro = store.isReadOnly();
  li.innerHTML = `
    <div class="note-head">
      <span class="note-type t-${n.type}">${NOTE_ICON[n.type] ?? '•'} ${n.type}</span>
      ${whoBadge(n.createdBy)}
      ${ro ? '' : `
      <span class="note-actions">
        <button class="icon-btn" data-edit="${n.id}" title="Edit note">✎</button>
        <button class="icon-btn" data-del="${n.id}" title="Delete note">✕</button>
      </span>`}
    </div>
    <p class="note-content">${esc(n.content)}</p>
    ${n.callId ? provenanceDetails(n.callId) : ''}`;
  li.addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    const edit = e.target.dataset.edit;
    if (del) {
      store.deleteNote(p.id, del);
    } else if (edit) {
      const note = p.notes.find((x) => x.id === edit);
      const box = document.createElement('div');
      box.className = 'note-edit';
      box.innerHTML = `
        <textarea maxlength="2000">${esc(note.content)}</textarea>
        <div class="row-end">
          <button class="btn btn-ghost btn-xs" data-cancel>cancel</button>
          <button class="btn btn-primary btn-xs" data-save>save</button>
        </div>`;
      li.querySelector('.note-content').replaceWith(box);
      box.querySelector('[data-cancel]').addEventListener('click', () => renderInspector());
      box.querySelector('[data-save]').addEventListener('click', () => {
        const v = box.querySelector('textarea').value.trim();
        if (v) {
          note.content = v;
          note.createdBy = 'human'; // editing = taking ownership
          store.emit();
        } else {
          renderInspector();
        }
      });
      box.querySelector('textarea').focus();
    }
  });
  return li;
}

function inboxPaperView(container, p) {
  container.innerHTML = `
    <div class="paper-head">
      <p class="inbox-tag">In Inbox — not yet in the workspace</p>
      <h2 class="paper-title">${esc(p.title)}</h2>
      <p class="paper-meta">${esc(p.authors.join(', ') || 'Unknown authors')} · ${p.year ?? 'n.d.'}</p>
      <p class="paper-meta dim">${esc(p.venue ?? '')} · ${p.citedBy} citations · ${esc(p.primaryTopic ?? '')}</p>
      <div class="paper-links">
        ${store.isReadOnly() ? '' : '<button class="btn btn-primary btn-xs" id="insp-add">＋ add to workspace</button>'}
        <a class="btn btn-ghost btn-xs" href="${esc(p.openalexUrl ?? `https://openalex.org/${p.id}`)}" target="_blank" rel="noopener">OpenAlex ↗</a>
        ${p.oaUrl ? `<a class="btn btn-ghost btn-xs" href="${esc(p.oaUrl)}" target="_blank" rel="noopener">open access PDF ↗</a>` : ''}
      </div>
    </div>
    ${p.abstract ? `<details class="abstract" open><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>`
      : '<p class="hint">No abstract available in OpenAlex.</p>'}
    <p class="hint pad-x">${store.isReadOnly()
      ? 'Your agent staged this from a search. Duplicate the snapshot to add it to your own workspace.'
      : 'Your agent staged this from a search. Add it to start a notes thread.'}</p>`;
  container.querySelector('#insp-add')?.addEventListener('click', () => {
    store.addPaper(p, { addedBy: 'human' });
    select(p.id);
  });
}

function paperTab(container, state) {
  const { paperId } = getSelection();
  if (!paperId) {
    container.innerHTML = `
      <div class="empty">
        <p><strong>Nothing selected.</strong></p>
        <p class="hint">Click any paper card to inspect it. Notes your agent writes appear here —
        every one carries provenance back to the tool call that produced it.</p>
      </div>`;
    return;
  }
  const wsPaper = store.getPaper(paperId);
  const inboxPaper = state.inbox.find((p) => p.id === paperId);
  if (!wsPaper && inboxPaper) {
    inboxPaperView(container, inboxPaper);
    return;
  }
  const p = wsPaper;
  if (!p) {
    container.innerHTML = `
      <div class="empty">
        <p><strong>Nothing selected.</strong></p>
        <p class="hint">Click any paper card to inspect it. Notes your agent writes appear here —
        every one carries provenance back to the tool call that produced it.</p>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="paper-head">
      <h2 class="paper-title">${esc(p.title)}</h2>
      <p class="paper-meta">${esc(p.authors.join(', ') || 'Unknown authors')} · ${p.year ?? 'n.d.'}</p>
      <p class="paper-meta dim">${esc(p.venue ?? '')} · ${p.citedBy} citations · ${esc(p.primaryTopic ?? '')}</p>
      <div class="paper-links">
        <a class="btn btn-ghost btn-xs" href="${esc(p.openalexUrl ?? `https://openalex.org/${p.id}`)}" target="_blank" rel="noopener">OpenAlex ↗</a>
        ${p.doi ? `<a class="btn btn-ghost btn-xs" href="${esc(p.doi)}" target="_blank" rel="noopener">DOI ↗</a>` : ''}
        ${p.oaUrl ? `<a class="btn btn-ghost btn-xs" href="${esc(p.oaUrl)}" target="_blank" rel="noopener">open access PDF ↗</a>` : ''}
      </div>
    </div>
    ${p.abstract ? `<details class="abstract" open><summary>Abstract</summary><p>${esc(p.abstract)}</p></details>` : '<p class="hint">No abstract available in OpenAlex.</p>'}
    <div class="notes-head">
      <h3>Notes <span class="hint">(${p.notes.length})</span></h3>
    </div>
    <div id="note-list" class="note-list"></div>
    <form id="note-form" class="note-form">
      <div class="row">
        <select id="note-type">${store.NOTE_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
        <button class="btn btn-primary btn-xs" type="submit">Add note</button>
      </div>
      <textarea id="note-content" placeholder="Write a note — it stays yours…" maxlength="2000"></textarea>
    </form>`;

  const list = container.querySelector('#note-list');
  for (const n of [...p.notes].reverse()) list.appendChild(noteView(p, n));

  container.querySelector('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const content = container.querySelector('#note-content').value.trim();
    if (!content) return;
    store.annotatePaper(p.id, {
      type: container.querySelector('#note-type').value,
      content,
      createdBy: 'human',
    });
  });
}

function artifactView(a) {
  const div = document.createElement('div');
  div.className = 'artifact';
  const ro = store.isReadOnly();
  div.innerHTML = `
    <div class="artifact-head">
      <span class="artifact-kind k-${a.kind}">${a.kind}</span>
      <h4>${esc(a.title)}</h4>
      ${whoBadge(a.createdBy)}
      ${ro ? '' : '<button class="icon-btn" data-del-art="' + a.id + '" title="Delete artifact">✕</button>'}
    </div>
    <div class="artifact-body md">${renderMarkdown(a.data.markdown)}</div>
    ${a.callId ? provenanceDetails(a.callId) : '<p class="hint tiny">added by you</p>'}
    ${a.sources?.length ? `
      <div class="artifact-sources">
        <span class="hint">grounded in:</span>
        ${a.sources.map((id) => {
          const p = store.getPaper(id);
          return p ? `<button class="chip chip-link" data-goto="${id}" title="${esc(p.title)}">${esc(p.title.slice(0, 40))}…</button>` : '';
        }).join('')}
        <button class="btn btn-ghost btn-xs" data-verify="${a.id}" title="Refetch every source from OpenAlex and compare with stored metadata">⟳ verify</button>
      </div>
      <div class="verify-result" data-verify-result="${a.id}"></div>` : ''}`;
  div.querySelector('[data-del-art]')?.addEventListener('click', () => store.deleteArtifact(a.id));
  div.querySelector('[data-goto]')?.addEventListener('click', (e) => select(e.target.dataset.goto));
  div.querySelector('[data-verify]')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '⟳ verifying…';
    // verify_sources logs to the activity trail, which re-renders this panel;
    // always paint into the CURRENT dom, never the captured (detached) node.
    const paint = (html) => {
      const target = document.querySelector(`[data-verify-result="${a.id}"]`);
      if (target) target.innerHTML = html;
    };
    const resetBtn = () => {
      const live = document.querySelector(`[data-verify="${a.id}"]`);
      if (live) { live.disabled = false; live.textContent = '⟳ verify'; }
    };
    try {
      const res = await verifySources(a.sources);
      paint(res.results.map((r) => {
        const p = store.getPaper(r.paper_id);
        const label = esc((p?.title ?? r.paper_id).slice(0, 36));
        if (r.status === 'verified') return `<span class="verify-chip v-ok" title="Title, year, venue match live OpenAlex">✓ ${label}</span>`;
        if (r.status === 'drifted') {
          const fields = Object.entries(r.drift).map(([f, d]) => `${f}: “${esc(String(d.stored).slice(0, 24))}” → “${esc(String(d.live).slice(0, 24))}”`).join('; ');
          return `<span class="verify-chip v-drift" title="${fields}">~ ${label} — ${fields}${r.cited_by_now != null ? ` · ${r.cited_by_now} cites now` : ''}</span>`;
        }
        return `<span class="verify-chip v-bad" title="${r.status}">✕ ${label} — ${r.status}</span>`;
      }).join('') + `<span class="hint tiny">${res.verified}/${res.total} verified live · ${res.checked_at.slice(11, 19)} UTC</span>`);
      resetBtn();
    } catch (err) {
      paint(`<span class="verify-chip v-bad">✕ verification failed: ${esc(String(err.message ?? err))}</span>`);
      resetBtn();
    }
  });
  return div;
}

function artifactsTab(container, state) {
  container.innerHTML = state.artifacts.length
    ? ''
    : `<div class="empty"><p><strong>No artifacts yet.</strong></p>
       <p class="hint">Ask your agent to compare papers, analyze gaps, or draft a related-work section —
       it publishes results here as editable artifacts.</p></div>`;
  for (const a of state.artifacts) container.appendChild(artifactView(a));
}

function activityTab(container, state) {
  container.innerHTML = `
    <p class="hint pad">Every agent tool call on this workspace, newest first — the provenance chain
    behind each note and artifact.</p>`;
  if (!state.activity.length) {
    container.insertAdjacentHTML('beforeend',
      '<div class="empty"><p class="hint">No tool calls yet. Your agent\'s calls land here — so do the demo agent\'s.</p></div>');
    return;
  }
  for (const c of state.activity) {
    const div = document.createElement('div');
    div.className = `call ${c.ok === false ? 'call-err' : ''}`;
    div.innerHTML = `
      <div class="call-head">
        <span class="mono call-tool">${esc(c.tool)}</span>
        <span class="badge ${c.source === 'demo-agent' ? 'badge-demo' : 'badge-agent'}">${c.source === 'demo-agent' ? 'demo agent' : 'browser agent'}</span>
        ${c.ok === false ? '<span class="badge badge-err">failed</span>' : ''}
        <span class="hint">${timeAgo(c.ts)}</span>
      </div>
      <details>
        <summary>input</summary>
        <pre class="prov-pre">${esc(JSON.stringify(c.input, null, 2))}</pre>
      </details>
      ${c.summary ? `<div class="call-sum">${esc(c.summary)}</div>` : ''}`;
    container.appendChild(div);
  }
}

export function renderInspector(container, state) {
  // don't clobber a note the human is typing/editing
  const active = document.activeElement;
  if (active && container.contains(active) &&
      (active.matches('textarea, input, select') || active.isContentEditable)) {
    return;
  }
  const { tab } = getSelection();
  const tabs = [
    ['paper', 'Paper'],
    ['artifacts', `Artifacts${state.artifacts.length ? ` (${state.artifacts.length})` : ''}`],
    ['activity', `Activity${state.activity.length ? ` (${state.activity.length})` : ''}`],
  ];
  container.innerHTML = `
    <nav class="tabs">
      ${tabs.map(([id, label]) => `<button class="tab ${tab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}
    </nav>
    <div class="tab-body" id="tab-body"></div>`;
  const body = container.querySelector('#tab-body');
  if (tab === 'artifacts') artifactsTab(body, state);
  else if (tab === 'activity') activityTab(body, state);
  else paperTab(body, state);

  container.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      // release focus so the render guard doesn't skip the tab switch
      if (document.activeElement && container.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      setTab(b.dataset.tab);
    }));
}

export function renderInspectorSafe(container, state) {
  try { renderInspector(container, state); } catch { /* keep last good frame */ }
}
