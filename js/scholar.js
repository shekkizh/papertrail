// Semantic Scholar Graph API client — an optional enrichment layer on top of
// OpenAlex. S2 adds what OpenAlex lacks: one-sentence TLDRs, verbatim citation
// contexts (HOW other papers cite a work, with intents), and a recommendations
// engine. CORS-enabled and keyless, but the unauthenticated pool rate-limits
// aggressively, so every call degrades gracefully: 429/404/network → null,
// and the calling tool falls back to OpenAlex-only data.

const BASE = 'https://api.semanticscholar.org/graph/v1';
const RECO_BASE = 'https://api.semanticscholar.org/recommendations/v1';

const resolveCache = new Map(); // openalexKey -> s2 paper or null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test hook: the cache shields rate limits in production, but tests need
// deterministic resolution against fresh stubs.
export function clearResolveCache() {
  resolveCache.clear();
}

async function getJSON(url, signal, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (res.status === 429 && attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`S2 ${res.status}`);
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      if (attempt < retries && !String(err.message).includes('S2 4')) {
        await sleep(1200);
        continue;
      }
      return null; // treat any S2 failure as "enrichment unavailable"
    }
  }
}

function normalizeTitle(t) {
  return String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Resolve an OpenAlex paper to an S2 paper record (by DOI, then title search).
export async function resolvePaper(paper, signal) {
  const key = paper.doi ?? `title:${normalizeTitle(paper.title)}`;
  if (resolveCache.has(key)) return resolveCache.get(key);
  let s2 = null;
  if (paper.doi) {
    const doiPath = encodeURIComponent(String(paper.doi).replace(/^https?:\/\/doi\.org\//i, ''));
    s2 = await getJSON(`${BASE}/paper/DOI:${doiPath}?fields=title,tldr,openAccessPdf,influentialCitationCount,fieldsOfStudy,citationCount`, signal);
  }
  if (!s2 && paper.title) {
    const found = await getJSON(
      `${BASE}/paper/search?query=${encodeURIComponent(paper.title.slice(0, 200))}&limit=1&fields=title,tldr,openAccessPdf,influentialCitationCount,fieldsOfStudy,citationCount`,
      signal,
    );
    const hit = found?.data?.[0];
    if (hit && normalizeTitle(hit.title) === normalizeTitle(paper.title)) s2 = hit;
  }
  const result = s2 ?? null;
  resolveCache.set(key, result);
  return result;
}

// TLDR + open-access PDF + influential citations for a paper, or null.
export async function enrich(paper, signal) {
  const s2 = await resolvePaper(paper, signal);
  if (!s2) return null;
  return {
    source: 'Semantic Scholar',
    tldr: s2.tldr?.text ?? null,
    openAccessPdf: s2.openAccessPdf?.url ?? null,
    influentialCitationCount: s2.influentialCitationCount ?? null,
    fieldsOfStudy: s2.fieldsOfStudy ?? null,
  };
}

// Verbatim citation contexts: sentences other papers wrote when citing this one,
// with intents (methodology / background / result). Null when unavailable.
export async function citationContexts(paper, { limit = 8, signal } = {}) {
  const s2 = await resolvePaper(paper, signal);
  if (!s2) return null;
  const data = await getJSON(
    `${BASE}/paper/${s2.paperId}/citations?fields=contexts,intents,title,year&limit=${Math.min(limit, 50)}`,
    signal,
    { retries: 0 },
  );
  if (!data?.data) return null;
  const citations = data.data
    .map((c) => ({
      citingPaper: c.title,
      year: c.year ?? null,
      intents: c.intents ?? [],
      contexts: (c.contexts ?? []).slice(0, 3),
    }))
    .filter((c) => c.contexts.length > 0);
  const intentTally = {};
  for (const c of citations) for (const i of c.intents) intentTally[i] = (intentTally[i] ?? 0) + 1;
  return {
    paper: { id: paper.id, title: paper.title },
    citationCount: s2.citationCount ?? paper.citedBy,
    contextsReturned: citations.length,
    intentTally,
    citations,
    note: 'Contexts are verbatim sentences from citing papers (Semantic Scholar). Ground any related-work claims about this paper in them.',
  };
}

// S2 recommendations (similar papers), as DOI candidates — the calling tool
// rehydrates them into canonical OpenAlex records. Null when unavailable.
export async function recommendations(paper, { limit = 6, signal } = {}) {
  const s2 = await resolvePaper(paper, signal);
  if (!s2) return null;
  const data = await getJSON(
    `${RECO_BASE}/papers/forpaper/${s2.paperId}?fields=title,year,citationCount,externalIds&limit=${Math.min(limit + 4, 20)}`,
    signal,
    { retries: 0 },
  );
  if (!data?.recommendedPapers) return null;
  const candidates = [];
  for (const w of data.recommendedPapers) {
    const doi = w.externalIds?.DOI ?? (w.externalIds?.ArXiv ? `10.48550/arXiv.${w.externalIds.ArXiv}` : null);
    if (doi) {
      candidates.push({ doi: doi.toLowerCase(), title: w.title, year: w.year ?? null, citedBy: w.citationCount ?? 0 });
    }
  }
  return candidates.slice(0, limit);
}
