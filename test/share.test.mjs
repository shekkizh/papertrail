// Hostile-snapshot sanitization: a share link is URL-controlled state. migrate()
// must rebuild every object through strict allowlists so nothing renderable can
// smuggle markup into innerHTML attribute interpolation. Regression tests for
// the share-link XSS class.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/state.js';

const EVIL = '"><img src=x onerror=alert(1)>';

const hostileSnapshot = {
  title: EVIL,
  lastQuery: EVIL,
  sections: [
    { id: `sec_${EVIL}`, title: 'Legit' },
    { id: 'sec_ok1', title: 'Kept' },
  ],
  papers: {
    W111: {
      id: 'W111', title: 'Paper', authors: ['A'], year: 2024, venue: null,
      citedBy: 1, primaryTopic: null, topics: [], abstract: 'ok',
      sectionId: `sec_${EVIL}`, // unknown → remapped to first section
      notes: [
        { id: `note_${EVIL}`, type: EVIL, content: EVIL, createdBy: EVIL, callId: EVIL, sources: [EVIL] },
        { id: 'note_ok1', type: 'finding', content: 'kept', createdBy: 'agent', callId: 'call_ok123', sources: ['W111'] },
      ],
    },
    [EVIL]: { id: EVIL, title: 'drop me' }, // non-W id → dropped
  },
  inbox: [{ id: EVIL, title: 'drop me' }, { id: 'W222', title: 'kept inbox paper', authors: [], notes: [] }],
  artifacts: [{
    id: `art_${EVIL}`, kind: EVIL, title: EVIL,
    data: { markdown: `# ok ${EVIL}` },
    createdBy: EVIL, callId: EVIL, sources: [EVIL, 'W111'],
    revisions: [{ callId: EVIL, ts: 'not-a-number' }, EVIL],
  }],
  activity: [
    { id: `call_${EVIL}`, ts: 'bad', tool: EVIL, input: EVIL, source: EVIL, summary: EVIL, ok: 'yes' },
    null,
  ],
};

test('migrate rebuilds hostile snapshots through strict allowlists', () => {
  store.init({ reset: true, fromSnapshot: hostileSnapshot });
  const s = store.getState();

  // ids: safe charsets only (they are interpolated into DOM attributes)
  for (const sec of s.sections) assert.match(sec.id, /^[a-z0-9_-]{3,40}$/i);
  const CALL_OK = /^call_[a-z0-9_-]{2,40}$/i;
  for (const p of Object.values(s.papers)) {
    assert.match(p.id, /^W\d+$/);
    for (const n of p.notes) {
      assert.match(n.id, /^note_[a-z0-9_-]{2,40}$/i);
      assert.ok(n.callId === null || CALL_OK.test(n.callId), `unsafe note callId: ${n.callId}`);
      for (const src of n.sources) assert.match(src, /^W\d+$/);
    }
  }
  for (const a of s.artifacts) {
    assert.match(a.id, /^art_[a-z0-9_-]{2,40}$/i);
    assert.ok(a.callId === null || CALL_OK.test(a.callId), `unsafe artifact callId: ${a.callId}`);
    for (const src of a.sources) assert.match(src, /^W\d+$/);
    for (const r of a.revisions) assert.equal(typeof r.ts, 'number');
  }
  for (const c of s.activity) assert.match(c.id, /^call_[a-z0-9_-]{2,40}$/i);

  // enums: note types / artifact kinds / activity sources whitelisted
  for (const p of Object.values(s.papers)) for (const n of p.notes) {
    assert.ok(store.NOTE_TYPES.includes(n.type));
    assert.ok(['human', 'agent'].includes(n.createdBy));
  }
  assert.ok(['comparison', 'gaps', 'draft', 'summary'].includes(s.artifacts[0].kind));
  for (const c of s.activity) assert.ok(['browser-agent', 'demo-agent', 'human'].includes(c.source));

  // foreign papers and inbox entries dropped entirely
  assert.deepEqual(Object.keys(s.papers), ['W111']);
  assert.deepEqual(s.inbox.map((p) => p.id), ['W222']);

  // dangling section reference remapped, notes rebuilt, title/lengths capped
  const paper = s.papers.W111;
  assert.ok(s.sections.some((x) => x.id === paper.sectionId));
  assert.equal(paper.notes[0].content, EVIL.slice(0, 2000).length ? paper.notes[0].content : '');
  assert.ok(s.title.length <= 120);
  assert.ok(s.artifacts[0].data.markdown.length <= 40000);

  // hostile id content never survives into an id-shaped field
  const idFields = [
    ...s.sections.map((x) => x.id),
    ...Object.values(s.papers).flatMap((p) => p.notes.map((n) => n.id)),
    ...s.artifacts.map((a) => a.id),
    ...s.activity.map((c) => c.id),
  ];
  for (const v of idFields) assert.ok(!v.includes('<') && !v.includes('"') && !v.includes(' '), `unsafe id: ${v}`);
});

test('round-trip: legit workspaces survive migrate unchanged in shape', () => {
  store.init({ reset: true });
  const { paper } = store.addPaper(
    { id: 'W333', title: 'T', authors: ['B'], year: 2023, venue: 'V', citedBy: 2, primaryTopic: null, topics: [], abstract: 'a' },
    { sectionId: 'sec_toread', addedBy: 'human' },
  );
  store.annotatePaper(paper.id, { type: 'method', content: 'c', createdBy: 'agent' });
  store.addArtifact({ kind: 'draft', title: 'D', data: { markdown: 'md' }, createdBy: 'agent' });
  const before = store.getState();
  store.init({ reset: true, fromSnapshot: JSON.parse(JSON.stringify(before)) });
  const after = store.getState();
  assert.equal(after.title, before.title);
  assert.deepEqual(after.sections.map((x) => x.id), before.sections.map((x) => x.id));
  assert.deepEqual(Object.keys(after.papers), Object.keys(before.papers));
  assert.equal(after.papers.W333.notes.length, 1);
  assert.equal(after.papers.W333.notes[0].type, 'method');
  assert.equal(after.artifacts[0].kind, 'draft');
  assert.equal(after.artifacts[0].data.markdown, 'md');
});

test('cross-tab sync: applying a remote snapshot replaces and re-emits', async () => {
  store.init({ reset: true });
  store.addPaper({ id: 'W444', title: 'Remote paper', authors: [], year: 2025, venue: null, citedBy: 0, primaryTopic: null, topics: [], abstract: null }, {});
  const encoded = await store.encodeWorkspace();
  // simulate the other tab: decode + boot from snapshot
  const snapshot = await store.decodeWorkspace(encoded.replace(/^gz:/, 'gz:'));
  store.init({ reset: true, fromSnapshot: snapshot });
  assert.ok(store.getPaper('W444'), 'remote write visible after sync');
});
