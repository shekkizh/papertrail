// Guided demo agent.
//
// When ChatGPT (or Chrome with WebMCP enabled) is the agent, IT drives this app's
// tools from outside. This module is an in-page agent that drives the exact same
// registered tools through the spec's client APIs — document.modelContext.getTools()
// + executeTool() where available, the local shim otherwise. It exists so the full
// human+agent experience is demonstrable in any browser, and it doubles as an
// end-to-end test harness for the tool surface.
//
// Everything it writes is grounded: summary notes come from fetched abstracts,
// tables come from tool-returned material, and every step lands in the Activity log.

import { callTool, webmcp } from '../webmcp.js';
import { setCallSource } from '../tools.js';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function sentences(text) {
  return String(text ?? '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10);
}
function clip(s, n) { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; }
function citeKey(p) { return `${(p.authors[0] ?? 'Unknown').split(' ').pop()} ${p.year ?? 'n.d.'}`; }

let dialog = null;
let logEl = null;
let running = false;

function log(html, cls = '') {
  const div = document.createElement('div');
  div.className = `demo-line ${cls}`;
  div.innerHTML = html;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

async function step(name, input, label) {
  log(`<span class="mono">▸ ${name}</span> <span class="dim">${esc(label ?? '')}</span>`);
  try {
    const result = await callTool(name, input);
    log(`<span class="dim">↳ ok</span>`);
    return result;
  } catch (err) {
    log(`<span class="err">↳ ${esc(String(err.message ?? err))}</span>`);
    return null;
  }
}

// ---------- artifact builders (all content derived from tool results) ----------

function comparisonMarkdown(topic, material) {
  const rows = material.papers.map((p) => {
    const focus = sentences(p.abstract_excerpt)[0] ?? p.title;
    return `| ${clip(p.title, 46)} | ${citeKey(p)} | ${p.venue ?? '—'} | ${clip(focus, 90)} | ${p.cited_by} |`;
  });
  return [
    `Material gathered via \`create_comparison\`; table written from abstracts and citation counts only.`,
    '',
    '| Paper | Cite as | Venue | Focus | Citations |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function gapsMarkdown(topic, analysis) {
  const hyps = analysis.gapHypotheses ?? [];
  if (!hyps.length) return null;
  return [
    `Statistical co-occurrence analysis over ${analysis.corpusSize} workspace papers (via \`identify_gaps\`):`,
    '',
    ...hyps.map((h, i) => `${i + 1}. ${h.hypothesis}`),
    '',
    `_Suggested next step: run a targeted \`search_literature\` for each hypothesis before treating these as true gaps._`,
  ].join('\n');
}

function connectionsMarkdown(connections) {
  const top = connections.slice(0, 4);
  return [
    '### How these papers connect',
    '',
    'Citation-graph analysis via `find_connections` (shared foundational references, authors, topics):',
    '',
    ...top.map((c) =>
      `- **${clip(c.a.title, 40)}** ⇄ **${clip(c.b.title, 40)}** — ${c.sharedReferenceCount} shared references${c.sharedAuthors.length ? `, shared authors (${c.sharedAuthors.slice(0, 2).join(', ')})` : ''}. ${c.note}.`),
  ].join('\n');
}

function draftMarkdown(topic, material, citationIntel) {
  const papers = material.papers;
  const intro = `Work on ${topic} has developed along several complementary lines. The papers collected here trace those lines from shared foundations to diverging emphases.`;
  const bodies = papers.map((p) => {
    const key = citeKey(p);
    const focus = sentences(p.abstract_excerpt)[0] ?? p.title;
    const noteLine = p.notes.length ? ` Our reading notes flag the ${p.notes[0].type}: “${clip(p.notes[0].content, 140)}”` : '';
    return `${key} ${clip(focus, 200)}${noteLine} [${p.paper_id}]`;
  });
  const closer = `Taken together, these works suggest the open questions tabulated in the gap analysis above — the combination(s) our corpus touches least may be exactly where the next contribution lands.`;
  const lines = [
    intro,
    '',
    ...bodies,
    '',
    closer,
  ];
  if (citationIntel?.citations?.length) {
    const cited = papers.find((p) => p.paper_id === citationIntel.paper?.id);
    if (cited) {
      lines.push(
        '',
        `**How the field cites [${citeKey(cited)}]** *(verbatim, via \`get_citation_contexts\`)*`,
        ...citationIntel.citations.slice(0, 2).map((c) =>
          `- “${clip(c.contexts[0], 160)}” — _${clip(c.citingPaper ?? 'unknown', 50)}_${c.year ? ` ${c.year}` : ''}`),
      );
    }
  }
  lines.push('', '**Referenced papers**', ...papers.map((p) => `- [${citeKey(p)}] ${clip(p.title, 70)} — \`${p.paper_id}\``));
  return lines.join('\n');
}

// ---------- scenario ----------

async function runScenario(topic) {
  setCallSource('demo-agent');
  try {
    log(`<strong>Guided demo agent</strong> — topic: “${esc(topic)}”. Driving the app's ${webmcp.mode === 'native' ? 'WebMCP-registered' : 'locally registered'} tools.`, 'demo-note');

    const ws = await step('get_workspace_state', {}, 'see the same canvas the human sees');
    log(`Workspace “${esc(ws?.title ?? '?')}”: ${ws?.sections?.length ?? 0} sections, ${ws?.sections?.reduce((n, s) => n + s.papers.length, 0) ?? 0} papers.`);

    const search = await step('search_literature', { query: topic, max_results: 8 }, 'search OpenAlex');
    if (!search?.result_count) { log('No results — try another topic.', 'err'); return; }
    log(`Found ${search.result_count}. Taking the three best relevance matches for a starter set.`);

    // results arrive in OpenAlex relevance order — keep it
    const picks = search.results.slice(0, 3);
    const added = await step('add_papers', { paper_ids: picks.map((p) => p.paper_id), section: 'To Read' }, 'place cards on the canvas');
    const ids = (added?.papers ?? []).filter((p) => p.paper_id).map((p) => p.paper_id);
    if (ids.length < 2) { log('Could not add enough papers to continue.', 'err'); return; }

    const details = [];
    for (const id of ids) {
      const d = await step('get_paper_details', { paper_id: id }, 'read the abstract');
      if (d?.abstract) {
        details.push(d);
        await step('annotate_paper', {
          paper_id: id,
          type: 'summary',
          content: clip(sentences(d.abstract).slice(0, 2).join(' '), 280),
        }, `summary note, grounded in the abstract of “${clip(d.title, 40)}”`);
      }
    }

    const cmp = await step('create_comparison', { paper_ids: ids }, 'gather structured material');
    if (cmp) {
      await step('save_artifact', {
        kind: 'comparison',
        title: `Comparison — ${topic}`,
        markdown: comparisonMarkdown(topic, cmp),
        sources: ids,
      }, 'publish the comparison table');
    }

    const gaps = await step('identify_gaps', {}, 'statistical gap analysis');
    if (gaps && !gaps.error) {
      const md = gapsMarkdown(topic, gaps);
      if (md) await step('save_artifact', { kind: 'gaps', title: `Candidate gaps — ${topic}`, markdown: md }, 'publish gap hypotheses');
      else log('No statistically salient gaps in this small corpus — noted.');
    }

    const conns = await step('find_connections', {}, 'citation-graph connections');
    if (conns?.connections?.length) {
      await step('save_artifact', {
        kind: 'summary',
        title: 'How these papers connect',
        markdown: connectionsMarkdown(conns.connections),
        sources: ids,
      }, 'publish the connection map');
    }

    const citationIntel = await step('get_citation_contexts', { paper_id: ids[0] }, 'how the field cites it — verbatim');
    if (citationIntel?.available === false) log('Citation contexts unavailable right now (Semantic Scholar rate limit) — drafting from abstracts.');

    const draft = await step('draft_related_work', { style: 'related-work' }, 'gather cited material for prose');
    if (draft) {
      await step('save_artifact', {
        kind: 'draft',
        title: `Related Work — ${topic} (draft)`,
        markdown: draftMarkdown(topic, draft, citationIntel),
        sources: draft.papers.map((p) => p.paper_id),
      }, 'publish the cited draft');
    }

    log(`<strong>Done.</strong> Cards, notes, and artifacts are on the canvas — edit anything. Every step above is auditable in the <em>Activity</em> tab.`, 'demo-note');
  } finally {
    setCallSource('browser-agent');
    running = false;
  }
}

export function openDemo(defaultTopic = 'LLM agent communication failures') {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'demo-dialog';
    dialog.innerHTML = `
      <div class="demo-head">
        <h2>Guided demo agent</h2>
        <button class="icon-btn" id="demo-close" title="Close">✕</button>
      </div>
      <p class="hint">An in-page agent driving this app's registered WebMCP tools (${webmcp.mode === 'native'
        ? 'via document.modelContext.executeTool — the same path your browser agent uses'
        : 'WebMCP is not active in this browser, so tools run through a local stand-in'}). In ChatGPT's browser, <em>you</em> would just type the prompt.</p>
      <form id="demo-form" class="demo-form">
        <input id="demo-topic" value="${esc(defaultTopic)}" placeholder="Research topic…" />
        <button class="btn btn-primary" type="submit" id="demo-run">Run demo</button>
      </form>
      <div id="demo-log" class="demo-log"></div>`;
    document.body.appendChild(dialog);
    dialog.querySelector('#demo-close').addEventListener('click', () => dialog.close());
  }
  logEl = dialog.querySelector('#demo-log');
  logEl.innerHTML = '';
  if (!running) {
    dialog.querySelector('#demo-form').onsubmit = (e) => {
      e.preventDefault();
      const topic = dialog.querySelector('#demo-topic').value.trim();
      if (!topic || running) return;
      running = true;
      logEl.innerHTML = '';
      runScenario(topic);
    };
  }
  dialog.showModal();
}
