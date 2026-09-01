// OpenAlex client — keyless, CORS-enabled scholarly graph (works, authors, citations).
// Docs: https://docs.openalex.org

const BASE = 'https://api.openalex.org';
const SEARCH_SELECT = [
  'id', 'doi', 'display_name', 'publication_year', 'authorships', 'cited_by_count',
  'primary_location', 'primary_topic', 'topics', 'type', 'open_access',
  'abstract_inverted_index',
].join(',');
const DETAIL_SELECT = `${SEARCH_SELECT},referenced_works,related_works`;

async function getJSON(path, signal) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAlex ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// OpenAlex stores abstracts as an inverted index {word: [positions]}.
export function abstractFromInverted(inv) {
  if (!inv) return null;
  const words = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.filter(Boolean).join(' ').trim();
  return text ? text.replace(/^abstract\s*[:.\-—]?\s*/i, '') || null : null;
}

export function trimWork(raw) {
  const authors = (raw.authorships ?? [])
    .map((a) => a.author?.display_name)
    .filter(Boolean);
  return {
    id: String(raw.id ?? '').split('/').pop(),
    doi: raw.doi ?? null,
    title: raw.display_name ?? 'Untitled',
    authors,
    year: raw.publication_year ?? null,
    venue: raw.primary_location?.source?.display_name ?? null,
    citedBy: raw.cited_by_count ?? 0,
    type: raw.type ?? null,
    primaryTopic: raw.primary_topic?.display_name ?? null,
    topics: (raw.topics ?? []).map((t) => t.display_name).slice(0, 5),
    oaUrl: raw.open_access?.oa_url ?? null,
    abstract: abstractFromInverted(raw.abstract_inverted_index),
    referencedWorks: raw.referenced_works ?? null,
    relatedWorks: raw.related_works ?? null,
    openalexUrl: raw.id ?? null,
  };
}

export async function searchWorks(query, { perPage = 8, fromYear = null, signal } = {}) {
  const params = new URLSearchParams({
    search: query,
    'per-page': String(Math.min(Math.max(perPage, 1), 25)),
    select: SEARCH_SELECT,
  });
  if (fromYear) params.set('filter', `from_publication_date:${fromYear}-01-01`);
  const data = await getJSON(`/works?${params}`, signal);
  return data.results.map(trimWork);
}

export async function getWork(openalexId, signal) {
  const id = String(openalexId).trim().replace(/^https?:\/\/openalex\.org\//, '');
  if (!/^W\d+$/i.test(id)) throw new Error(`Not an OpenAlex work id: ${openalexId}`);
  return trimWork(await getJSON(`/works/${id}?select=${DETAIL_SELECT}`, signal));
}

export async function hydrateWorks(ids, signal) {
  const clean = ids.map((i) => String(i).split('/').pop()).filter((i) => /^W\d+$/i.test(i));
  if (!clean.length) return [];
  const data = await getJSON(
    `/works?filter=openalex_id:${clean.join('|')}&select=${DETAIL_SELECT}&per-page=${clean.length}`,
    signal,
  );
  return data.results.map(trimWork);
}

// Canonical OpenAlex records for external DOI hints (e.g. from Semantic
// Scholar recommendations). Missing DOIs simply drop out of the result.
export async function hydrateByDois(dois, signal) {
  const clean = [...new Set(dois.filter(Boolean).map((d) => String(d).toLowerCase()))].slice(0, 25);
  if (!clean.length) return [];
  const data = await getJSON(
    `/works?filter=doi:${clean.map((d) => `https://doi.org/${d}`).join('|')}&select=${DETAIL_SELECT}&per-page=${clean.length}`,
    signal,
  );
  return data.results.map(trimWork);
}

// Related work for a seed: its OpenAlex `related_works`, topped up with recent
// works that cite it when relations are sparse (common for brand-new papers).
export async function suggestRelated(seedId, { limit = 6, excludeIds = [], signal } = {}) {
  const seed = await getWork(seedId, signal);
  const relatedIds = (seed.relatedWorks ?? []).slice(0, limit);
  let results = relatedIds.length ? await hydrateWorks(relatedIds, signal) : [];
  if (results.length < 3) {
    const citing = await getJSON(
      `/works?filter=cites:${seed.id}&sort=cited_by_count:desc&per-page=${limit}&select=${SEARCH_SELECT}`,
      signal,
    );
    results = results.concat(citing.results.map(trimWork));
  }
  const seen = new Set([seed.id, ...excludeIds]);
  return {
    seed: { id: seed.id, title: seed.title, year: seed.year },
    suggestions: results.filter((w) => !seen.has(w.id)).slice(0, limit),
  };
}

// Pairwise relationships for a set of papers: shared references, shared
// authors, shared topics. Deterministic client-side graph work.
export async function findConnections(papers, { signal } = {}) {
  const needDetail = papers.filter((p) => !p.referencedWorks);
  if (needDetail.length) {
    const hydrated = await hydrateWorks(needDetail.map((p) => p.id), signal);
    const byId = new Map(hydrated.map((w) => [w.id, w]));
    for (const p of papers) {
      const h = byId.get(p.id);
      if (h) p.referencedWorks = h.referencedWorks;
    }
  }
  const pairs = [];
  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const a = papers[i];
      const b = papers[j];
      const refsA = new Set(a.referencedWorks ?? []);
      const refsB = new Set(b.referencedWorks ?? []);
      const sharedRefs = [...refsA].filter((r) => refsB.has(r));
      const sharedAuthors = (a.authors ?? []).filter((x) => (b.authors ?? []).includes(x));
      const sharedTopics = (a.topics ?? []).filter((t) => (b.topics ?? []).includes(t));
      const strength = sharedRefs.length * 2 + sharedAuthors.length + sharedTopics.length;
      pairs.push({
        a: { id: a.id, title: a.title },
        b: { id: b.id, title: b.title },
        sharedReferenceCount: sharedRefs.length,
        sharedAuthors,
        sharedTopics,
        strength,
        note:
          sharedRefs.length >= 3 ? 'strongly related (shared foundational references)' :
          sharedRefs.length > 0 ? 'related (some shared references)' :
          sharedAuthors.length ? 'same research group/author' :
          sharedTopics.length ? 'adjacent topic area' : 'no obvious link',
      });
    }
  }
  return pairs.sort((x, y) => y.strength - x.strength);
}

// Corpus analytics over the workspace: topical coverage, year spread, and
// high-frequency topics that never co-occur — candidate survey gaps.
export function identifyGaps(papers) {
  if (papers.length < 3) {
    return { error: 'Need at least 3 papers in the workspace to identify gaps.' };
  }
  const topicCount = new Map();
  const pairCount = new Map();
  const yearHist = {};
  const venues = new Map();
  for (const p of papers) {
    yearHist[p.year ?? 'unknown'] = (yearHist[p.year ?? 'unknown'] ?? 0) + 1;
    if (p.venue) venues.set(p.venue, (venues.get(p.venue) ?? 0) + 1);
    const topics = [...new Set([p.primaryTopic, ...(p.topics ?? [])].filter(Boolean))].slice(0, 3);
    for (const t of topics) topicCount.set(t, (topicCount.get(t) ?? 0) + 1);
    for (let i = 0; i < topics.length; i++) {
      for (let j = i + 1; j < topics.length; j++) {
        const key = [topics[i], topics[j]].sort().join(' × ');
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }
  const topTopics = [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topPairs = [...pairCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  // Frequent topics whose co-occurrence is much rarer than their individual
  // frequency would suggest = candidate gaps.
  const candidates = [];
  for (let i = 0; i < topTopics.length; i++) {
    for (let j = i + 1; j < topTopics.length; j++) {
      const [t1, c1] = topTopics[i];
      const [t2, c2] = topTopics[j];
      const key = [t1, t2].sort().join(' × ');
      const co = pairCount.get(key) ?? 0;
      const expected = Math.min(c1, c2);
      if (expected >= 2 && co <= expected / 2) {
        candidates.push({
          hypothesis: `"${t1}" and "${t2}" are both prominent in this corpus but rarely treated together (${co} of ${expected} expected overlaps).`,
          topics: [t1, t2],
          support: { topicCounts: [c1, c2], coOccurrences: co },
        });
      }
    }
  }
  return {
    corpusSize: papers.length,
    yearRange: [
      Math.min(...papers.map((p) => p.year ?? 9999)) || null,
      Math.max(...papers.map((p) => p.year ?? 0)) || null,
    ],
    topicFrequency: Object.fromEntries(topTopics),
    commonTopicPairs: Object.fromEntries(topPairs),
    venueSpread: Object.fromEntries([...venues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)),
    gapHypotheses: candidates.slice(0, 5),
    note: 'Gap hypotheses are statistical (co-occurrence based), not judgments. Verify with a targeted search_literature call.',
  };
}
