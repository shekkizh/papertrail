// App bootstrap: wire state → UI, register WebMCP tools, header chrome,
// share links, and the Site-tools explorer.

import * as store from './state.js';
import { setupWebMCP, webmcp, getRegistryForExplorer, activeToolDefs, shareToolCount } from './webmcp.js';
import { toolDefs, toMarkdown, toBibtex } from './tools.js';
import { renderBoard } from './ui/board.js';
import { renderSearch } from './ui/search.js';
import { renderInspectorSafe } from './ui/inspector.js';
import { openDemo } from './ui/demoagent.js';
import { onSelect, getSelection } from './ui/selection.js';

const $ = (id) => document.getElementById(id);

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const isEditable = (el) =>
  el && (el.matches?.('input, textarea, select') || el.isContentEditable);

function renderBanner(status) {
  const banner = $('banner');
  const chip = $('agent-status');
  if (store.isReadOnly()) {
    banner.hidden = false;
    banner.innerHTML = `
      <strong>You're viewing a shared snapshot.</strong>
      <span>It's read-only here. <button id="banner-dup" class="linklike">Duplicate to my browser</button>
      to edit it — your agent can then operate your copy with the app's WebMCP tools.</span>`;
    $('banner-dup').addEventListener('click', duplicateSnapshot);
    chip.className = 'status-chip chip-preview';
    chip.textContent = `◐ shared snapshot · ${status.count} read tools`;
    return;
  }
  if (status.mode === 'native') {
    banner.hidden = true;
    chip.className = 'status-chip chip-live';
    const broken = status.errors.length ? ` (${status.errors.length} failed)` : '';
    chip.title = status.errors.length
      ? `Registration failures: ${status.errors.map((e) => `${e.name}: ${e.message}`).join('; ')}`
      : 'Tools registered on document.modelContext — open Site tools in your agent\'s browser to see them';
    chip.textContent = `● ${status.count} tools live for agents${broken}`;
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <strong>WebMCP is not active in this browser.</strong>
    <span>The app is running its tools locally so you can still explore — try the
    <button id="banner-demo" class="linklike">guided demo</button> to watch an in-page agent use them.
    To give a real agent control, open PaperTrail in ChatGPT's browser, or Chrome with
    <code>chrome://flags/#enable-webmcp-testing</code> enabled.</span>`;
  $('banner-demo').addEventListener('click', () => openDemo());
  chip.className = 'status-chip chip-preview';
  chip.title = 'document.modelContext unavailable — running with a local stand-in';
  chip.textContent = `◐ ${status.count} tools (local preview)`;
}

// ---------- Site-tools explorer ----------

async function openToolsExplorer() {
  let dialog = $('tools-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'tools-dialog';
    document.body.appendChild(dialog);
  }
  const tools = await getRegistryForExplorer();
  dialog.innerHTML = `
    <div class="demo-head">
      <h2>Site tools <span class="hint">— what any WebMCP agent discovers here</span></h2>
      <button class="icon-btn" id="tools-close" title="Close">✕</button>
    </div>
    <p class="hint">Registered on <code>document.modelContext</code> in this top-level document. In ChatGPT's
    browser or Chrome with the WebMCP flag, this exact set appears to the agent.</p>
    <div class="tools-list">
      ${tools.map((t) => `
        <details class="tool-entry">
          <summary>
            <span class="mono tool-name">${t.name}</span>
            ${t.annotations?.readOnlyHint ? '<span class="badge badge-read">read</span>' : '<span class="badge badge-write">write</span>'}
            ${t.annotations?.untrustedContentHint ? '<span class="badge badge-untrusted">untrusted content</span>' : ''}
          </summary>
          <p class="tool-desc">${t.description}</p>
          <pre class="prov-pre">${JSON.stringify(t.inputSchema, null, 2)}</pre>
        </details>`).join('')}
    </div>`;
  dialog.querySelector('#tools-close').addEventListener('click', () => dialog.close());
  dialog.showModal();
}

// ---------- share links ----------

async function shareWorkspace() {
  const encoded = await store.encodeWorkspace();
  const url = `${location.origin}${location.pathname}#w=${encoded}`;
  if (url.length > 30000) {
    alert(`This workspace is too large for a share link (${Math.round(url.length / 1024)} KB). Export JSON and share the file instead.`);
    return;
  }
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    toast(`Share link copied — visiting agents get ${shareToolCount()} read-only tools to audit it.`);
  } catch {
    prompt('Share this link (copied link includes the full snapshot):', url);
  }
}

async function duplicateSnapshot() {
  const s = store.getState();
  try {
    localStorage.setItem('papertrail.workspace.v1', JSON.stringify(s));
  } catch { /* quota */ }
  history.replaceState(null, '', location.pathname);
  location.reload();
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('show'), 20);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4200);
}

async function bootFromShareLink() {
  const m = location.hash.match(/^#w=(.+)$/);
  if (!m) return false;
  try {
    const snapshot = await store.decodeWorkspace(m[1]);
    store.setReadOnly(true);
    store.init({ reset: true, fromSnapshot: snapshot });
    return true;
  } catch (err) {
    console.error('[PaperTrail] share link decode failed', err);
    return false;
  }
}

// ---------- header ----------

function renderHeader(state) {
  const title = $('ws-title');
  if (title.textContent !== state.title && document.activeElement !== title) {
    title.textContent = state.title;
  }
}

async function boot() {
  const shared = await bootFromShareLink();
  store.init();
  const board = $('board');
  const searchRail = $('search-rail');
  const inspector = $('inspector');

  const render = (state) => {
    // Panels containing focused editable elements are skipped, so agent
    // activity never destroys a half-typed note or rename.
    const active = document.activeElement;
    const holdsFocus = (el) => el.contains(active) && isEditable(active);
    if (!holdsFocus(board)) renderBoard(board, state);
    if (!holdsFocus(searchRail)) renderSearch(searchRail, state);
    if (!holdsFocus(inspector)) renderInspectorSafe(inspector, state);
    renderHeader(state);
  };
  store.subscribe(render);
  onSelect(() => {
    store.setUiContext(getSelection());
    renderInspectorSafe(inspector, store.getState());
  });
  render(store.getState());

  // Renames
  $('ws-title').addEventListener('blur', () => {
    const v = $('ws-title').textContent.trim();
    if (v) store.setTitle(v);
    else $('ws-title').textContent = store.getState().title;
  });
  $('ws-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });

  // Export menu
  const menu = $('export-menu');
  $('export-btn').addEventListener('click', () => { menu.hidden = !menu.hidden; });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) menu.hidden = true;
  });
  menu.addEventListener('click', (e) => {
    const fmt = e.target.dataset.fmt;
    if (!fmt) return;
    menu.hidden = true;
    if (fmt === 'bibtex') download('papertrail.bib', toBibtex(), 'text/plain');
    else if (fmt === 'json') download('papertrail.json', JSON.stringify(store.getState(), null, 2), 'application/json');
    else download('papertrail.md', toMarkdown(), 'text/markdown');
  });

  $('tools-btn').addEventListener('click', openToolsExplorer);
  $('share-btn').addEventListener('click', shareWorkspace);
  $('demo-btn').addEventListener('click', () => openDemo());
  $('reset-btn').addEventListener('click', () => {
    if (confirm('Clear the whole workspace? This cannot be undone.')) store.resetWorkspace();
  });
  if (shared) {
    $('share-btn').hidden = true;
    $('reset-btn').hidden = true;
    $('demo-btn').hidden = true;
  }

  setupWebMCP().then((status) => {
    const count = status.mode === 'native' ? status.registered.length : activeToolDefs().length;
    renderBanner({ mode: status.mode, count, errors: status.errors });
    console.info(
      `[PaperTrail] WebMCP mode: ${status.mode}. Registered tools:`,
      status.registered.length ? status.registered : activeToolDefs().map((t) => t.name),
      status.errors.length ? status.errors : '',
    );
  });
}

boot();
