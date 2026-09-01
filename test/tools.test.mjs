// End-to-end test of PaperTrail's WebMCP tool surface against the live OpenAlex API.
// The same tool definitions the app registers on document.modelContext are driven
// here directly — this is the contract an agent sees.
//
//   npm test

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../js/state.js';
import { toolDefs, toolByName, toMarkdown, toBibtex, setCallSource, verifySources } from '../js/tools.js';

const TOPIC = 'large language model reasoning';

function call(name, input) {
  const tool = toolByName(name);
  assert.ok(tool, `tool ${name} must be defined`);
  return tool.execute(input, {});
}

test('tool surface: 16 well-formed tools', () => {
  assert.equal(toolDefs.length, 16);
  const names = new Set();
  for (const t of toolDefs) {
    assert.match(t.name, /^[a-zA-Z0-9_.-]{1,128}$/, `name ${t.name} must satisfy WebMCP naming rules`);
    assert.ok(t.description.length >= 3, `${t.name} needs a description`);
    assert.equal(typeof t.execute, 'function', `${t.name} needs execute`);
    assert.ok(t.inputSchema?.type === 'object', `${t.name} needs an object schema`);
    assert.equal(typeof t.inputSchema.additionalProperties, 'boolean', `${t.name} schema should close additionalProperties`);
    assert.ok(!names.has(t.name), 'names unique');
    names.add(t.name);
  }
});

test('search_literature finds works and stages the inbox', async () => {
  store.init({ reset: true });
  const res = await call('search_literature', { query: TOPIC, max_results: 6 });
  assert.ok(res.result_count >= 3, 'expected several results');
  assert.equal(res.results.length, res.result_count);
  for (const r of res.results) {
    assert.match(r.paper_id, /^W\d+$/);
    assert.ok(r.title.length > 5);
    assert.equal(typeof r.cited_by, 'number');
  }
  assert.equal(store.getState().inbox.length, res.result_count, 'inbox staged');
});

test('add_papers places cards + per-paper notes with provenance', async () => {
  const inbox = store.getState().inbox;
  const ids = inbox.slice(0, 3).map((p) => p.id);
  const res = await call('add_papers', {
    paper_ids: ids.slice(0, 2),
    section: 'To Read',
    notes: [
      { paper_id: ids[0], type: 'summary', content: 'Grounded summary for the first paper.' },
      { paper_id: 'W0000000000', type: 'summary', content: 'orphan — should be reported as skipped' },
    ],
  });
  assert.equal(res.added_to, 'To Read');
  assert.ok(res.papers.every((p) => p.added));
  assert.deepEqual(res.skipped_notes, [
    { paper_id: 'W0000000000', reason: 'paper_id not part of this call' },
  ]);
  const papers = store.getSectionPapers(store.getState().sections[0].id);
  assert.equal(papers.length, 2);
  assert.equal(papers[0].addedBy, 'agent');
  assert.equal(papers[0].notes.length, 1);
  assert.equal(papers[0].notes[0].createdBy, 'agent');
  assert.equal(papers[1].notes.length, 0, 'notes only attach to their paper');
  const activity = store.getState().activity;
  assert.ok(activity.length >= 1);
  assert.equal(activity[0].tool, 'add_papers');
});

test('get_paper_details returns abstracts', { timeout: 90000 }, async () => {
  const id = store.allPapers()[0].id;
  const d = await call('get_paper_details', { paper_id: id });
  assert.equal(d.id, id);
  assert.ok(d.in_workspace);
  assert.ok(d.abstract === null || d.abstract.length > 50);
});

test('annotate_paper writes a note with provenance chain', async () => {
  const p = store.allPapers()[0];
  const n = await call('annotate_paper', { paper_id: p.id, type: 'limitation', content: 'Only evaluated on GSM8K-style tasks.' });
  assert.ok(n.note_id);
  const note = store.getPaper(p.id).notes.find((x) => x.id === n.note_id);
  assert.equal(note.type, 'limitation');
  assert.equal(note.createdBy, 'agent');
  const prov = store.provenanceOf(note.callId);
  assert.equal(prov.tool, 'annotate_paper');
  assert.equal(prov.input.paper_id, p.id);
  assert.equal(prov.ok, true);
});

test('create_comparison gathers material for 2-6 papers', async () => {
  const ids = store.allPapers().slice(0, 2).map((p) => p.id);
  const res = await call('create_comparison', { paper_ids: ids, dimensions: ['method', 'benchmarks'] });
  assert.equal(res.papers.length, 2);
  assert.deepEqual(res.suggested_dimensions, ['method', 'benchmarks']);
  assert.ok(res.papers[0].notes.length >= 1);
  await assert.rejects(() => call('create_comparison', { paper_ids: [ids[0]] }), /minItems|"needs at least"|at least/);
});

test('find_connections computes pairwise relationships', async () => {
  const res = await call('find_connections', {});
  assert.ok(res.analyzed >= 2);
  assert.ok(res.connections.length >= 1);
  for (const c of res.connections) {
    assert.equal(typeof c.strength, 'number');
    assert.ok(c.note.length > 3);
  }
});

test('identify_gaps: refuses tiny corpora, then analyzes a real one', async () => {
  const small = await call('identify_gaps', {});
  if (store.allPapers().length < 3) {
    assert.ok(small.error);
    const third = store.getState().inbox[2] ?? store.getState().inbox[0];
    await call('add_papers', { paper_ids: [third.id] });
  }
  const res = await call('identify_gaps', {});
  assert.ok(!res.error);
  assert.ok(res.corpusSize >= 3);
  assert.ok(res.topicFrequency && Object.keys(res.topicFrequency).length > 0);
  assert.ok(Array.isArray(res.gapHypotheses));
});

test('draft_related_work returns citation-grounded material', async () => {
  const res = await call('draft_related_work', { style: 'related-work' });
  assert.ok(res.papers.length >= 2);
  for (const p of res.papers) assert.match(p.paper_id, /^W\d+$/);
  assert.match(res.citation_style, /paper_id/);
});

test('save_artifact publishes agent prose with sources', async () => {
  const ids = store.allPapers().map((p) => p.id).slice(0, 2);
  const res = await call('save_artifact', {
    kind: 'comparison',
    title: 'Test comparison',
    markdown: '| a | b |\n| --- | --- |\n| 1 | 2 |',
    sources: [...ids, 'W999999999'],
  });
  assert.ok(res.artifact_id);
  assert.equal(res.updated_in_place, false);
  assert.equal(res.sources_count, ids.length);
  assert.equal(res.ignored_unknown_sources, 1);
  const art = store.getState().artifacts[0];
  assert.equal(art.createdBy, 'agent');
  assert.ok(store.provenanceOf(art.callId));
});

test('get_artifact reads the human-edited canvas; save_artifact revises in place', async () => {
  const art = store.getState().artifacts[0];
  // human edits the artifact directly (UI path)
  art.data.markdown = '| a | b |\n| --- | --- |\n| human edit | 2 |';
  store.emit();
  const read = await call('get_artifact', { artifact_id: art.id });
  assert.match(read.markdown, /human edit/, 'agent sees the human edit');
  assert.equal(read.kind, 'comparison');
  const revised = await call('save_artifact', {
    artifact_id: art.id,
    kind: 'comparison',
    title: art.title,
    markdown: '| a | b |\n| --- | --- |\n| human edit | agent revision |',
    sources: read.sources,
  });
  assert.equal(revised.updated_in_place, true);
  assert.equal(revised.revision_count, 1);
  const after = store.getState().artifacts.find((x) => x.id === art.id);
  assert.match(after.data.markdown, /agent revision/);
  assert.equal(after.revisions.length, 1, 'revision is receipted');
  await assert.rejects(() => call('get_artifact', { artifact_id: 'art_nope' }), /Unknown artifact/);
  await assert.rejects(() => call('save_artifact', {
    artifact_id: art.id, kind: 'draft', title: art.title, markdown: 'x',
  }), /refusing to reinterpret/);
});

test('verify_sources refetches and reports live grounding', { timeout: 90000 }, async () => {
  const art = store.getState().artifacts[0];
  const res = await verifySources(art.sources.slice(0, 2));
  assert.equal(res.total, res.results.length);
  for (const r of res.results) {
    assert.ok(['verified', 'drifted', 'unreachable', 'not_in_workspace'].includes(r.status));
    if (r.status === 'verified') assert.ok(r.checked_field.includes('OpenAlex'));
  }
  const log = store.getState().activity;
  assert.equal(log[0].tool, 'verify_sources');
  assert.match(log[0].summary, /verified/);
});

test('human selection is exposed to agents in workspace state', async () => {
  store.setUiContext({ paperId: store.allPapers()[0].id, tab: 'paper' });
  const ws = await call('get_workspace_state', {});
  assert.ok(ws.human_selection);
  assert.equal(ws.human_selection.inspector_tab, 'paper');
  assert.ok(ws.artifacts.length >= 1);
  for (const a of ws.artifacts) assert.match(a.id, /^art_/);
});

test('get_citation_contexts: verbatim contexts, or graceful degradation', { timeout: 90000 }, async () => {
  const p = store.allPapers()[0];
  const res = await call('get_citation_contexts', { paper_id: p.id, max_citations: 5 });
  assert.equal(res.paper_id, p.id);
  if (res.available === false) {
    assert.ok(res.note.includes('rate-limited') || res.note.includes('not indexed'),
      'degraded response explains itself');
  } else {
    assert.ok(res.citations.length >= 1, 'expected at least one citing-paper context');
    for (const c of res.citations) {
      assert.ok(c.citingPaper);
      assert.ok(Array.isArray(c.contexts) && c.contexts.length > 0);
      assert.ok(c.contexts[0].length > 20, 'contexts are verbatim sentences');
    }
    assert.ok(typeof res.intentTally === 'object');
  }
});

test('suggest_related stages new candidates in the inbox', { timeout: 90000 }, async () => {
  const before = new Set(store.allPapers().map((p) => p.id));
  const res = await call('suggest_related', { limit: 4 });
  assert.ok(res.seed.id);
  for (const s of res.suggestions) assert.ok(!before.has(s.paper_id), 'suggestions exclude workspace papers');
});

test('move_papers / remove_papers mutate the board', async () => {
  const p = store.allPapers()[0];
  const moved = await call('move_papers', { paper_ids: [p.id], to_section: 'Synthesized' });
  assert.equal(moved.moved_count, 1);
  assert.equal(store.getPaper(p.id).sectionId, 'sec_synth');
  const removed = await call('remove_papers', { paper_ids: [p.id] });
  assert.equal(removed.removed_count, 1);
  assert.equal(store.getPaper(p.id), null);
});

test('export_workspace produces markdown and bibtex', async () => {
  const md = await call('export_workspace', { format: 'markdown' });
  assert.match(md.content, /^# /);
  assert.match(md.content, /## (To Read|Reading|Synthesized)/);
  const bib = await call('export_workspace', { format: 'bibtex' });
  assert.match(bib.content, /@article\{/);
  const exported = toMarkdown();
  assert.ok(exported.length > 100);
  assert.match(toBibtex(), /title = \{/);
});

test('validation: schemas reject bad agent input with useful errors', async () => {
  await assert.rejects(() => call('search_literature', {}), /missing required property "query"/);
  await assert.rejects(() => call('annotate_paper', { paper_id: 'W1', type: 'rant', content: 'x' }), /must be one of/);
  await assert.rejects(() => call('add_papers', { paper_ids: [] }), /at least 1/);
  await assert.rejects(() => call('move_papers', { paper_ids: ['W1'], to_section: 'Nowhere' }), /Unknown section/);
  await assert.rejects(() => call('get_paper_details', { paper_id: 'not-an-id' }), /Not an OpenAlex work id/);
  await assert.rejects(() => call('search_literature', { query: 'x', bogus: true }), /unexpected property "bogus"/);
  await assert.rejects(() => call('add_papers', { paper_ids: ['W1'], notes: [{ paper_id: 'W1', type: 'nope', content: 'x' }] }), /must be one of/);
  await assert.rejects(() => call('annotate_paper', { paper_id: 'W1', type: 'summary', content: '' }), /at least 1 character/);
});

test('activity log: every call is auditable', () => {
  const log = store.getState().activity;
  assert.ok(log.length >= 12, 'expected a rich trail');
  for (const entry of log) {
    assert.ok(entry.tool);
    assert.ok(entry.ts);
    assert.ok(['browser-agent', 'demo-agent', 'human'].includes(entry.source));
    assert.ok([true, false, null].includes(entry.ok));
  }
  const failed = log.filter((e) => e.ok === false);
  assert.ok(failed.length >= 4, 'failed validation calls are recorded too');
});

test('reset works', () => {
  store.resetWorkspace();
  assert.equal(store.allPapers().length, 0);
  assert.equal(store.getState().artifacts.length, 0);
});
