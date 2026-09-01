// App bootstrap: wire state → UI, register WebMCP tools, header chrome.

import * as store from './state.js';
import { setupWebMCP, webmcp } from './webmcp.js';
import { toolDefs, toMarkdown, toBibtex } from './tools.js';
import { renderBoard } from './ui/board.js';
import { renderSearch } from './ui/search.js';
import { renderInspectorSafe } from './ui/inspector.js';
import { openDemo } from './ui/demoagent.js';
import { onSelect } from './ui/selection.js';

const $ = (id) => document.getElementById(id);

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function renderBanner(status) {
  const banner = $('banner');
  if (status.mode === 'native') {
    banner.hidden = true;
    const chip = $('agent-status');
    chip.className = 'status-chip chip-live';
    chip.title = 'Tools registered on document.modelContext — open Site tools in your agent\'s browser to see them';
    chip.textContent = `● ${status.count} tools live for agents`;
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
  const chip = $('agent-status');
  chip.className = 'status-chip chip-preview';
  chip.title = 'document.modelContext unavailable — running with a local stand-in';
  chip.textContent = `◐ ${status.count} tools (local preview)`;
}

function renderHeader(state) {
  const title = $('ws-title');
  if (title.textContent !== state.title && document.activeElement !== title) {
    title.textContent = state.title;
  }
}

function boot() {
  store.init();
  const board = $('board');
  const searchRail = $('search-rail');
  const inspector = $('inspector');

  const render = (state) => {
    renderBoard(board, state);
    renderSearch(searchRail, state);
    renderInspectorSafe(inspector, state);
    renderHeader(state);
  };
  store.subscribe(render);
  render(store.getState());

  // Renames
  $('ws-title').addEventListener('blur', () => {
    const v = $('ws-title').textContent.trim();
    if (v) store.setTitle(v);
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

  $('demo-btn').addEventListener('click', () => openDemo());
  $('reset-btn').addEventListener('click', () => {
    if (confirm('Clear the whole workspace? This cannot be undone.')) store.resetWorkspace();
  });

  onSelect(() => renderInspectorSafe(inspector, store.getState()));

  setupWebMCP().then((status) => {
    renderBanner({ mode: status.mode, count: status.registered.length || toolDefs.length });
    console.info(
      `[PaperTrail] WebMCP mode: ${status.mode}. Registered tools:`,
      status.registered.length ? status.registered : toolDefs.map((t) => t.name),
      status.errors.length ? status.errors : '',
    );
  });
}

boot();
