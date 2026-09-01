// Semantic Scholar integration tests with a stubbed S2 endpoint.
// The live S2 unauthenticated pool rate-limits unpredictably (429s), so these
// tests pin the plumbing — DOI resolution, context/intent mapping, TLDR
// enrichment, recommendations → OpenAlex rehydration — deterministically.
// Live S2 behavior is exercised manually/by the graceful-degradation test in tools.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../js/state.js';
import { toolByName } from '../js/tools.js';
import { clearResolveCache } from '../js/scholar.js';

const realFetch = globalThis.fetch;

function s2Json(body) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function stubS2(routes) {
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern)) return responder(url);
    }
    return realFetch(input); // OpenAlex etc. go live
  };
}

const DOI = '10.55555/stub-paper';

test('citation contexts flow: DOI resolve → verbatim contexts + intents', async () => {
  store.init({ reset: true });
  clearResolveCache();
  stubS2([
    [`paper/DOI:${encodeURIComponent(DOI)}?`, () =>
      s2Json({ paperId: 'S2STUB1', title: 'Stub Paper', citationCount: 42 })],
    ['paper/S2STUB1/citations', () =>
      s2Json({
        data: [
          {
            title: 'A Citing Paper', year: 2024, intents: ['methodology'],
            contexts: ["Building on the stub paper's framing [12], we adopt its formulation."],
          },
          {
            title: 'Another Citing Paper', year: 2023, intents: ['background'],
            contexts: ['The stub paper established the baseline.'],
          },
        ],
      })],
  ]);
  try {
    const paper = store.addPaper({
      id: 'WSTUB1', doi: `https://doi.org/${DOI}`, title: 'Stub Paper', authors: ['A. Author'],
      year: 2022, venue: 'StubConf', citedBy: 40, primaryTopic: 'stub', topics: [], abstract: 'The abstract.',
    }, { sectionId: 'sec_toread' }).paper;

    const res = await toolByName('get_citation_contexts').execute({ paper_id: paper.id }, {});
    assert.equal(res.available, true);
    assert.equal(res.citationCount, 42);
    assert.deepEqual(res.intentTally, { methodology: 1, background: 1 });
    assert.equal(res.citations[0].citingPaper, 'A Citing Paper');
    assert.match(res.citations[0].contexts[0], /stub paper's framing/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('get_paper_details carries S2 enrichment (TLDR, PDF)', async () => {
  clearResolveCache();
  stubS2([
    ['graph/v1/paper/', () =>
      s2Json({
        paperId: 'S2STUB2', title: 'Stub Paper', tldr: { text: 'One-sentence summary.' },
        openAccessPdf: { url: 'https://example.com/paper.pdf' }, influentialCitationCount: 9,
        fieldsOfStudy: ['Computer Science'], citationCount: 42,
      })],
  ]);
  try {
    const res = await toolByName('get_paper_details').execute({ paper_id: 'WSTUB1' }, {});
    assert.equal(res.enrichment.tldr, 'One-sentence summary.');
    assert.equal(res.enrichment.openAccessPdf, 'https://example.com/paper.pdf');
    assert.equal(res.enrichment.influentialCitationCount, 9);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('S2 outage degrades to OpenAlex-only answers', async () => {
  // a paper never resolved before — earlier tests seeded the resolve cache
  store.addPaper({
    id: 'WOUTAGE1', doi: 'https://doi.org/10.55555/outage-paper', title: 'Outage Paper',
    authors: ['B. Author'], year: 2023, venue: null, citedBy: 5, primaryTopic: null,
    topics: [], abstract: 'OpenAlex-side abstract survives an S2 outage.',
  }, { sectionId: 'sec_toread' });
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('semanticscholar.org')) {
      return new Response('{"error": "too many requests"}', { status: 429 });
    }
    return realFetch(input);
  };
  try {
    const res = await toolByName('get_paper_details').execute({ paper_id: 'WOUTAGE1' }, {});
    assert.equal(res.enrichment, null, 'enrichment is null, not an error');
    assert.ok(res.abstract, 'OpenAlex data still present');
    const ctx = await toolByName('get_citation_contexts').execute({ paper_id: 'WOUTAGE1' }, {});
    assert.equal(ctx.available, false);
    assert.ok(ctx.note.length > 10);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('recommendations: S2 DOI hints rehydrate into canonical OpenAlex records', async () => {
  clearResolveCache();
  const openalexWorks = {
    results: [
      { id: 'https://openalex.org/W111111111', display_name: 'Real Transformer Paper',
        publication_year: 2023, authorships: [], cited_by_count: 500 },
      { id: 'https://openalex.org/W222222222', display_name: 'ArXiv-Only Rec',
        publication_year: 2024, authorships: [], cited_by_count: 3 },
      { id: 'https://openalex.org/W333333333', display_name: 'Third Rec',
        publication_year: 2022, authorships: [], cited_by_count: 30 },
    ],
  };
  stubS2([
    ['graph/v1/paper/', () => s2Json({ paperId: 'S2STUB1', title: 'Stub Paper' })],
    ['recommendations/v1/', () =>
      s2Json({
        recommendedPapers: [
          { paperId: 'R1', title: 'Real Transformer Paper', year: 2023, citationCount: 500,
            externalIds: { DOI: '10.55555/real-one' } },
          { paperId: 'R2', title: 'ArXiv-Only Rec', year: 2024, citationCount: 3,
            externalIds: { ArXiv: '2401.99999' } },
          { paperId: 'R3', title: 'No Ids Rec', year: 2024, citationCount: 1, externalIds: {} },
          { paperId: 'R4', title: 'Third Rec', year: 2022, citationCount: 30,
            externalIds: { DOI: '10.55555/also-real' } },
        ],
      })],
    ['openalex.org', (url) => {
      assert.ok(url.includes('filter=doi:'), 'hydration queries OpenAlex by DOI');
      return s2Json(openalexWorks);
    }],
  ]);
  try {
    const res = await toolByName('suggest_related').execute({ paper_id: 'WSTUB1', limit: 5 }, {});
    assert.equal(res.source, 'semantic-scholar');
    assert.equal(res.suggestion_count, 3);
    // every returned suggestion must be a canonical OpenAlex record the agent can add_papers
    for (const s of res.suggestions) assert.match(s.paper_id, /^W\d+$/, 'rehydrated to OpenAlex id');
  } finally {
    globalThis.fetch = realFetch;
  }
});
