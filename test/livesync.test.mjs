// Live-sync state tests: the op outbox must capture every mutation, drain
// cleanly, and reproduce an identical workspace when applied remotely —
// that's the contract the server relays between devices.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/state.js';

const paper = (id, title) => ({
  id, doi: null, title, authors: ['A. Author'], year: 2024, venue: 'V',
  citedBy: 3, type: 'article', primaryTopic: 't', topics: ['t'],
  oaUrl: null, abstract: 'abstract text', referencedWorks: null, openalexUrl: `https://openalex.org/${id}`,
});

test('live ops: every mutation lands in the outbox exactly once', () => {
  store.init({ reset: true });
  store.setTitle('Live survey');
  const { paper: p } = store.addPaper(paper('W9001', 'One'), { addedBy: 'human' });
  store.movePaper(p.id, 'sec_reading');
  store.annotatePaper(p.id, { type: 'finding', content: 'f' });
  const n = store.getPaper(p.id).notes[0];
  store.deleteNote(p.id, n.id);
  store.addArtifact({ kind: 'draft', title: 'D', data: { markdown: 'md' }, createdBy: 'agent' });
  const art = store.getState().artifacts[0];
  store.updateArtifact(art.id, { markdown: 'md2' });
  store.setInbox([paper('W9002', 'Two')], { query: 'q' });

  const ops = store.drainOutbox();
  const kinds = ops.map((o) => o.kind);
  assert.deepEqual(kinds, [
    'title.set', 'paper.add', 'paper.move', 'note.add',
    'note.delete', 'artifact.add', 'artifact.update', 'inbox.set',
  ]);
  for (const op of ops) {
    assert.ok(op.ts > 0);
    assert.equal(op.actor, store.getClientId());
  }
  assert.deepEqual(store.drainOutbox(), [], 'drain empties the outbox');
});

test('live ops: remote application reproduces the workspace; no re-outbox loop', () => {
  store.init({ reset: true });
  store.setTitle('Live survey');
  const { paper: p } = store.addPaper(paper('W9001', 'One'), { addedBy: 'agent', callId: 'call_x1' });
  store.movePaper(p.id, 'sec_reading');
  store.annotatePaper(p.id, { type: 'limitation', content: 'only mice', createdBy: 'agent' });
  store.addArtifact({ kind: 'comparison', title: 'C', data: { markdown: '|a|b|' }, createdBy: 'agent', sources: [p.id] });
  const ops = store.drainOutbox();

  // a second device boots empty and applies the same op stream
  store.init({ reset: true });
  store.applyRemoteOps(ops);
  const s = store.getState();
  assert.equal(s.title, 'Live survey');
  assert.equal(s.papers.W9001.sectionId, 'sec_reading');
  assert.equal(s.papers.W9001.notes.length, 1);
  assert.equal(s.papers.W9001.notes[0].content, 'only mice');
  assert.equal(s.artifacts.length, 1);
  assert.deepEqual(store.drainOutbox(), [], 'remote application must not re-outbox');

  // remote mutations apply idempotently (server retries, duplicate delivery)
  store.applyRemoteOps(ops);
  assert.equal(Object.keys(s.papers).length, 1);
  assert.equal(s.papers.W9001.notes.length, 1);
  assert.equal(s.artifacts.length, 1);

  // a locally-created op on the replica carries a distinct actor and flows out
  store.annotatePaper('W9001', { type: 'summary', content: 'replica note', createdBy: 'agent' });
  const replicaOps = store.drainOutbox();
  assert.equal(replicaOps.length, 1);
  assert.equal(replicaOps[0].kind, 'note.add');
});

test('live ops: hostile remote payloads are contained', () => {
  store.init({ reset: true });
  store.applyRemoteOps([
    { kind: 'paper.add', payload: { paper: { id: 'W1"><img>', title: 'x', notes: [] } } },
    { kind: 'paper.add', payload: { paper: { id: 'W7001', title: 'ok', authors: [], year: '2020"><img>', notes: [{ id: 'note_x1', type: 'summary', content: 'c' }] } } },
    { kind: 'artifact.update', payload: { artifactId: 'art_nope', markdown: 'ignored' } },
    { kind: 'section.rename', payload: { sectionId: 'sec_nope', title: 'ghost' } },
  ]);
  const s = store.getState();
  assert.ok(!Object.keys(s.papers).some((id) => id.includes('<')), 'non-W ids dropped');
  assert.equal(s.papers.W7001.year, null, 'hostile year coerced');
  assert.ok(s.papers.W7001.notes.length === 0 || store.NOTE_TYPES.includes(s.papers.W7001.notes[0].type));
  assert.equal(s.artifacts.length, 0);
});
