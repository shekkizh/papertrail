// App bootstrap: wire state → UI, register WebMCP tools, header chrome,
// share links, and the Site-tools explorer.

import * as store from './state.js';
import * as sync from './sync.js';
import { setupWebMCP, webmcp, getRegistryForExplorer, activeToolDefs, shareToolCount } from './webmcp.js';
import { toolDefs, toMarkdown, toBibtex } from './tools.js';
import { renderBoard } from './ui/board.js';
import { renderSearch } from './ui/search.js';
import { renderInspectorSafe } from './ui/inspector.js';
import { openDemo } from './ui/demoagent.js';
import { onSelect, getSelection, setTab } from './ui/selection.js';

const $ = (id) => document.getElementById(id);
let panelSkipped = false; // a render skipped a focused panel — repaint on focusout

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const isEditable = (el) =>
  el && (el.matches?.('input, textarea, select') || el.isContentEditable);

// ---------- live pulse strip ----------
// One dot per tool call, newest right. The "same canvas, same time" made
// visible: agent writes, demo runs, and human actions stream here — and via
// cross-tab sync, in every open view of the workspace.

function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function renderPulse(state) {
  const strip = $('pulse');
  if (!state.activity.length) { strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = `
    <span class="pulse-label">live trail</span>` +
    state.activity.slice(0, 48).map((c) =>
      `<button class="pulse-dot p-${c.source} ${c.ok === false ? 'p-fail' : ''}"
        title="${esc(c.tool)} · ${c.source === 'demo-agent' ? 'demo agent' : c.source} · ${timeAgo(c.ts)}${c.ok === false ? ' (failed)' : ''}"
        aria-label="${esc(c.tool)}"></button>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// ---------- live mode (cross-device sync) ----------

function renderLiveStatus(status) {
  const chip = $('live-status');
  if (!status) { chip.hidden = true; return; }
  chip.hidden = false;
  if (status.ok) {
    chip.textContent = `⚡ live · ${status.peers} online`;
    chip.title = `Synced to live workspace ${sync.currentId ?? ''} — human and agent actions replicate to every open device`;
  } else {
    chip.textContent = '◌ reconnecting…';
    chip.title = `Live sync retrying: ${status.error ?? ''} (queued ops are kept)`;
  }
}

async function goLive() {
  $('live-btn').disabled = true;
  $('live-btn').textContent = '⚡ creating…';
  try {
    const { id } = await sync.createLive();
    try { sessionStorage.setItem('papertrail.ownHash', '1'); } catch { /* private mode */ }
    const url = `${location.origin}${location.pathname}?live=${id}`;
    history.replaceState(null, '', url);
    toast('Workspace is live — the link in your address bar syncs every device.');
    location.reload();
  } catch (err) {
    toast(`Going live failed: ${err.message}`);
    $('live-btn').disabled = false;
    $('live-btn').textContent = '⚡ Go live';
  }
}

async function bootLive() {
  const liveId = new URLSearchParams(location.search).get('live');
  if (!liveId || !/^[a-z0-9]{6,20}$/.test(liveId)) return null;
  const { seq } = await sync.joinLive(liveId);
  sync.currentId = liveId;
  sync.startSync(liveId, renderLiveStatus);
  $('live-btn').hidden = true;
  $('reset-btn').hidden = true;
  const share = $('share-btn');
  share.textContent = 'Copy live link';
  share.title = 'Copy the live link — anyone (and their agent) opening it joins this workspace';
  return { liveId, seq };
}

async function shareWorkspace() {
  // in live mode the share button distributes the live link instead
  if (sync.currentId) {
    const url = `${location.origin}${location.pathname}?live=${sync.currentId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Live link copied — every device (and every agent) that opens it joins this workspace.');
    } catch {
      prompt('Live link:', url);
    }
    return;
  }
  const encoded = await store.encodeWorkspace();
  const url = `${location.origin}${location.pathname}#w=${encoded}`;
  if (url.length > 30000) {
    alert(`This workspace is too large for a share link (${Math.round(url.length / 1024)} KB). Export JSON and share the file instead.`);
    return;
  }
  history.replaceState(null, '', url);
  // mark this tab as the snapshot's owner so reloading it never boots the
  // (frozen) hash over the live workspace
  try { sessionStorage.setItem('papertrail.ownHash', '1'); } catch { /* private mode */ }
  try {
    await navigator.clipboard.writeText(url);
    toast(`Share link copied — visiting agents get ${shareToolCount()} read-only tools to audit it.`);
  } catch {
    prompt('Share this link (copied link includes the full snapshot):', url);
  }
}

async function duplicateSnapshot() {
  let existing = null;
  try { existing = JSON.parse(localStorage.getItem('papertrail.workspace.v1') || 'null'); } catch { /* corrupt */ }
  const hasWork = existing?.papers && Object.keys(existing.papers).length > 0;
  if (hasWork && !confirm('Replace your current workspace with this shared snapshot? Your current papers will be overwritten.')) {
    return;
  }
  const s = store.getState();
  try {
    localStorage.setItem('papertrail.workspace.v1', JSON.stringify(s));
  } catch { /* quota */ }
  try { sessionStorage.setItem('papertrail.ownHash', '1'); } catch { /* private mode */ }
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
  // this tab already owns a live workspace (it created or duplicated this
  // snapshot) — never boot the frozen hash over it
  try {
    if (sessionStorage.getItem('papertrail.ownHash') === '1') {
      history.replaceState(null, '', location.pathname + location.search);
      return false;
    }
  } catch { /* private mode */ }
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
  const liveId = new URLSearchParams(location.search).get('live');
  store.init();
  store.wireCrossTabSync();
  let live = null;
  if (liveId && /^[a-z0-9]{6,20}$/.test(liveId)) {
    try {
      live = await bootLive();
    } catch (err) {
      toast(`Joining live workspace failed: ${err.message}`);
      $('live-status').hidden = true;
    }
  } else {
    await bootFromShareLink();
  }
  const board = $('board');
  const searchRail = $('search-rail');
  const inspector = $('inspector');

  const render = (state) => {
    // Panels containing focused editable elements are skipped, so agent
    // activity never destroys a half-typed note or rename.
    const active = document.activeElement;
    const holdsFocus = (el) => el.contains(active) && isEditable(active);
    const boardSkip = holdsFocus(board);
    const searchSkip = holdsFocus(searchRail);
    const inspSkip = holdsFocus(inspector);
    if (!boardSkip) renderBoard(board, state);
    if (!searchSkip) renderSearch(searchRail, state);
    if (!inspSkip) renderInspectorSafe(inspector, state);
    panelSkipped = boardSkip || searchSkip || inspSkip;
    renderHeader(state);
    renderPulse(state);
  };
  store.subscribe(render);
  onSelect(() => {
    store.setUiContext(getSelection());
    renderInspectorSafe(inspector, store.getState());
  });
  render(store.getState());

  // If a burst of agent writes landed while the human was focused in a panel,
  // that panel was skipped — repaint it once focus leaves (deferred past any
  // in-flight click, and only when something was actually skipped).
  let lastPointerDown = 0;
  window.addEventListener('pointerdown', () => { lastPointerDown = Date.now(); });
  document.addEventListener('focusout', () => {
    if (!panelSkipped) return;
    setTimeout(() => {
      if (Date.now() - lastPointerDown < 300) return; // a click is in flight
      if (isEditable(document.activeElement)) return; // focus moved elsewhere
      panelSkipped = false;
      render(store.getState());
    }, 150);
  });

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
  $('live-btn').addEventListener('click', goLive);
  $('demo-btn').addEventListener('click', () => openDemo());
  $('reset-btn').addEventListener('click', () => {
    if (confirm('Clear the whole workspace? This cannot be undone.')) store.resetWorkspace();
  });
  if (!live && store.isReadOnly()) {
    $('share-btn').hidden = true;
    $('reset-btn').hidden = true;
    $('demo-btn').hidden = true;
    $('live-btn').hidden = true;
    $('ws-title').setAttribute('contenteditable', 'false');
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
