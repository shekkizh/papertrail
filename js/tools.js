// PaperTrail's WebMCP tool surface — the app's real data model, exposed to agents.
// DOM-free: registered via document.modelContext in the browser, driven directly in
// Node tests. Every call is recorded in the workspace activity log with its inputs,
// so agent-written notes and artifacts always carry provenance.

import * as store from './state.js';
import * as oa from './openalex.js';
import * as scholar from './scholar.js';

let callSource = 'browser-agent';
export function setCallSource(source) { callSource = source; }

// ---------- input validation (schemas are advisory to agents; this is the floor) ----------

function fail(msg) { throw new Error(msg); }

function validate(input, schema, toolName, path = '') {
  if (schema.type !== 'object') return;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(`${toolName}: input must be an object`);
  }
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) fail(`${toolName}: missing required property "${key}"`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) {
      if (!(key in (schema.properties ?? {}))) {
        fail(`${toolName}: unexpected property "${key}"`);
      }
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const v = input[key];
    if (v === undefined) continue;
    const label = path ? `${path}.${key}` : key;
    switch (prop.type) {
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v) || v === null) {
          fail(`${toolName}: "${label}" must be an object`);
        }
        if (prop.properties) validate(v, prop, toolName, label);
        break;
      case 'string':
        if (typeof v !== 'string') fail(`${toolName}: "${label}" must be a string`);
        if (prop.enum && !prop.enum.includes(v)) {
          fail(`${toolName}: "${label}" must be one of ${prop.enum.join(', ')}`);
        }
        if (prop.maxLength && v.length > prop.maxLength) {
          fail(`${toolName}: "${label}" exceeds ${prop.maxLength} characters`);
        }
        break;
      case 'integer':
      case 'number':
        if (!Number.isInteger(v) && prop.type === 'integer') fail(`${toolName}: "${label}" must be an integer`);
        if (typeof v !== 'number') fail(`${toolName}: "${label}" must be a number`);
        if (prop.minimum !== undefined && v < prop.minimum) fail(`${toolName}: "${label}" must be >= ${prop.minimum}`);
        if (prop.maximum !== undefined && v > prop.maximum) fail(`${toolName}: "${label}" must be <= ${prop.maximum}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') fail(`${toolName}: "${label}" must be a boolean`);
        break;
      case 'array':
        if (!Array.isArray(v)) fail(`${toolName}: "${label}" must be an array`);
        if (prop.minItems !== undefined && v.length < prop.minItems) fail(`${toolName}: "${label}" needs at least ${prop.minItems} item(s)`);
        if (prop.maxItems !== undefined && v.length > prop.maxItems) fail(`${toolName}: "${label}" allows at most ${prop.maxItems} items`);
        if (prop.items?.type === 'string') {
          if (v.some((x) => typeof x !== 'string')) fail(`${toolName}: "${label}" must contain only strings`);
        }
        if (prop.items?.type === 'object' && prop.items.properties) {
          for (const item of v) validate(item, prop.items, toolName, `${label}[]`);
        }
        break;
      default:
        break;
    }
  }
}

const excerpt = (s, n) => (!s ? null : s.length <= n ? s : `${s.slice(0, n).trimEnd()}…`);

function compact(w) {
  return {
    paper_id: w.id,
    title: w.title,
    authors: w.authors.slice(0, 3),
    year: w.year,
    venue: w.venue,
    cited_by: w.citedBy,
    primary_topic: w.primaryTopic,
    abstract_snippet: excerpt(w.abstract, 240),
  };
}

function resolveSection(ref) {
  const sections = store.getState().sections;
  if (!ref) return sections[0];
  return sections.find((s) => s.id === ref || s.title.toLowerCase() === String(ref).toLowerCase()) ?? null;
}

function paperMaterial(p, { abstractChars = 600 } = {}) {
  return {
    paper_id: p.id,
    title: p.title,
    authors: p.authors.slice(0, 5),
    year: p.year,
    venue: p.venue,
    cited_by: p.citedBy,
    primary_topic: p.primaryTopic,
    abstract_excerpt: excerpt(p.abstract, abstractChars),
    section: store.getState().sections.find((s) => s.id === p.sectionId)?.title,
    notes: p.notes.map((n) => ({ type: n.type, content: n.content, written_by: n.createdBy })),
    doi: p.doi,
    openalex_url: p.openalexUrl,
  };
}

// ---------- export builders (shared by the tool and the UI download button) ----------

export function toMarkdown() {
  const s = store.getState();
  const lines = [`# ${s.title}`, ''];
  for (const section of s.sections) {
    lines.push(`## ${section.title}`, '');
    for (const p of store.getSectionPapers(section.id)) {
      lines.push(`### ${p.title}`, '');
      lines.push(
        `- Authors: ${p.authors.join(', ') || 'unknown'} (${p.year ?? 'n.d.'})`,
        `- Venue: ${p.venue ?? '—'} · Citations: ${p.citedBy}`,
        `- OpenAlex: ${p.openalexUrl ?? p.id}${p.doi ? ` · DOI: ${p.doi}` : ''}`,
      );
      if (p.abstract) lines.push('', `> ${excerpt(p.abstract, 400)}`);
      for (const n of p.notes) {
        lines.push(``, `**[${n.type}]** ${n.content} _(${n.createdBy})_`);
      }
      lines.push('');
    }
  }
  for (const a of s.artifacts) {
    lines.push(`## Artifact: ${a.title} _(${a.kind}, by ${a.createdBy})_`, '', a.data.markdown ?? JSON.stringify(a.data), '');
  }
  return lines.join('\n');
}

export function toBibtex() {
  const entries = store.allPapers().map((p, i) => {
    const key = `${(p.authors[0] ?? 'unknown').split(' ').pop().toLowerCase()}${p.year ?? ''}`;
    return [
      `@article{${key}${i},`,
      `  title = {${p.title}},`,
      `  author = {${p.authors.join(' and ')}},`,
      `  year = {${p.year ?? ''}},`,
      `  journal = {${p.venue ?? ''}},`,
      `  doi = {${(p.doi ?? '').replace('https://doi.org/', '')}},`,
      `  url = {${p.openalexUrl ?? p.id}}`,
      `}`,
    ].join('\n');
  });
  return entries.join('\n\n');
}

// ---------- tool definitions ----------

function tool(def) {
  return {
    ...def,
    execute: async (input, options = {}) => {
      const callId = store.recordCall(def.name, input ?? {}, callSource);
      try {
        validate(input ?? {}, def.inputSchema ?? { type: 'object' }, def.name);
        const result = await def.execute(input ?? {}, { ...options, callId });
        store.completeCall(
          callId,
          typeof result?.ok === 'string' ? result.ok : excerpt(JSON.stringify(result) ?? '', 140),
          true,
        );
        return result;
      } catch (err) {
        store.completeCall(callId, `error: ${err.message}`, false);
        throw err;
      }
    },
  };
}

export const toolDefs = [
  tool({
    name: 'search_literature',
    title: 'Search literature',
    description:
      'Search OpenAlex (250M+ scholarly works) by keyword. Results are staged in the app Inbox panel so the ' +
      'human can see them (a new search replaces the previous staging); nothing is added to the workspace ' +
      'until add_papers is called. Results include abstract snippets — usually enough to pick the best papers ' +
      'and write grounded summary notes without extra calls.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search phrase, e.g. "LLM agent communication failure"' },
        max_results: { type: 'integer', minimum: 1, maximum: 15, description: 'Default 8.' },
        from_year: { type: 'integer', description: 'Only include works published this year or later.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    // stages results in the human-visible Inbox, so it is state-mutating
    annotations: { untrustedContentHint: true },
    async execute({ query, max_results = 8, from_year = null }, { signal } = {}) {
      const results = await oa.searchWorks(query, { perPage: max_results, fromYear: from_year, signal });
      store.setInbox(results, { query });
      return {
        query,
        result_count: results.length,
        results: results.map(compact),
        next_step: 'Results are visible in the Inbox. Use add_papers (with per-paper notes where useful) to place them on the workspace.',
      };
    },
  }),

  tool({
    name: 'get_paper_details',
    title: 'Get paper details',
    description:
      'Full record for one paper: abstract, topics, venue, citations, DOI, plus Semantic Scholar ' +
      'enrichment when available (one-sentence TLDR, open-access PDF, influential citation count). ' +
      'Works for ids already in the workspace, in the Inbox, or any OpenAlex work id (W…).',
    inputSchema: {
      type: 'object',
      properties: { paper_id: { type: 'string', description: 'OpenAlex work id, e.g. W2124364966' } },
      required: ['paper_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute({ paper_id }, { signal } = {}) {
      const local = store.getPaper(paper_id) ?? store.getState().inbox.find((p) => p.id === paper_id);
      const work = local?.abstract !== undefined && local?.abstract !== null ? local : await oa.getWork(paper_id, signal);
      const wsPaper = store.getPaper(paper_id);
      const enrichment = await scholar.enrich({ doi: work.doi, title: work.title }, signal);
      return {
        ...work,
        enrichment,
        in_workspace: Boolean(wsPaper),
        section: wsPaper ? store.getState().sections.find((s) => s.id === wsPaper.sectionId)?.title : null,
        notes: wsPaper?.notes ?? [],
      };
    },
  }),

  tool({
    name: 'get_citation_contexts',
    title: 'Read citation contexts',
    description:
      'How other papers actually cite this work: verbatim sentences from citing papers with intents ' +
      '(methodology/background/result), via Semantic Scholar. Use it to characterize a paper accurately ' +
      'in comparisons and related-work drafts — what claim of the paper really travels in the literature.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_id: { type: 'string' },
        max_citations: { type: 'integer', minimum: 3, maximum: 20, description: 'Default 8.' },
      },
      required: ['paper_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute({ paper_id, max_citations = 8 }, { signal } = {}) {
      const p = store.getPaper(paper_id) ?? store.getState().inbox.find((x) => x.id === paper_id);
      const work = p ?? await oa.getWork(paper_id, signal);
      const res = await scholar.citationContexts(work, { limit: max_citations, signal });
      if (!res) {
        return {
          paper_id,
          available: false,
          note: 'Semantic Scholar is rate-limited or has not indexed this paper. Characterize it from the abstract instead.',
        };
      }
      return { available: true, paper_id, ...res };
    },
  }),

  tool({
    name: 'get_workspace_state',
    title: 'Read workspace state',
    description:
      'The human and you are looking at the same canvas. Call this first: it shows every section, paper, ' +
      'note count, and artifact — plus what the human currently has selected in the inspector ' +
      '(human_selection), so you can react to what they are reading.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async execute() {
      return {
        ...store.workspaceSnapshot(),
        how_to_read:
          'sections[] list their papers; addedBy says who placed each paper (human/agent). ' +
          'human_selection is what the human is inspecting right now. Use get_artifact(artifact_id) to read an artifact\'s full current text — including the human\'s edits.',
      };
    },
  }),

  tool({
    name: 'get_artifact',
    title: 'Read an artifact',
    description:
      'Read the full current text of one artifact (comparison table, gap analysis, related-work draft) by id. ' +
      'This returns what the canvas holds NOW — including any edits the human made after you published. ' +
      'Read it before revising anything.',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string', description: 'From get_workspace_state artifacts[].id' } },
      required: ['artifact_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute({ artifact_id }) {
      const a = store.getState().artifacts.find((x) => x.id === artifact_id);
      if (!a) {
        fail(`Unknown artifact "${artifact_id}". Call get_workspace_state for current artifact ids.`);
      }
      return {
        artifact_id: a.id,
        kind: a.kind,
        title: a.title,
        markdown: a.data.markdown,
        sources: a.sources ?? [],
        revisions: (a.revisions ?? []).length,
        created_by: a.createdBy,
        provenance_call_id: a.callId,
      };
    },
  }),

  tool({
    name: 'add_papers',
    title: 'Add papers to workspace',
    description:
      'Add papers from the Inbox (or by OpenAlex id) to a section of the canvas. The cards appear immediately ' +
      'for the human. Optionally attach per-paper notes via "notes" — one entry per paper_id, each grounded ' +
      'in that paper\'s abstract snippet (from search results) or details.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
        section: { type: 'string', description: 'Section title or id. Defaults to the first section.' },
        notes: {
          type: 'array',
          description: 'Optional per-paper notes. Match paper_id to the papers you are adding.',
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              paper_id: { type: 'string' },
              type: { type: 'string', enum: store.NOTE_TYPES },
              content: { type: 'string', maxLength: 2000 },
            },
            required: ['paper_id', 'type', 'content'],
          },
        },
      },
      required: ['paper_ids'],
      additionalProperties: false,
    },
    async execute({ paper_ids, section = null, notes = [] }, { signal, callId } = {}) {
      const target = resolveSection(section);
      if (section && !target) fail(`Unknown section "${section}". Sections: ${store.getState().sections.map((s) => s.title).join(', ')}`);
      const out = [];
      for (const id of paper_ids) {
        const staged = store.getPaper(id) ?? store.getState().inbox.find((p) => p.id === id);
        const work = staged ?? await oa.getWork(id, signal);
        const { paper, added } = store.addPaper(work, {
          sectionId: target.id,
          addedBy: callSource === 'human' ? 'human' : 'agent',
          callId,
        });
        let noteAttached = false;
        const note = added ? notes.find((n) => n.paper_id === id) : null;
        if (note) {
          store.annotatePaper(paper.id, { type: note.type, content: note.content, createdBy: 'agent', callId, sources: [paper.id] });
          noteAttached = true;
        }
        out.push({ paper_id: paper.id, title: paper.title, added, section: target.title, note_attached: noteAttached });
      }
      return {
        added_to: target.title,
        papers: out,
        skipped_notes: notes.filter((n) => !paper_ids.includes(n.paper_id)).map((n) => n.paper_id),
        visible_to_human: true,
      };
    },
  }),

  tool({
    name: 'move_papers',
    title: 'Move papers between sections',
    description: 'Move one or more papers to another section of the canvas, e.g. promoting papers you judged relevant to "Reading".',
    inputSchema: {
      type: 'object',
      properties: {
        paper_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
        to_section: { type: 'string', description: 'Target section title or id.' },
      },
      required: ['paper_ids', 'to_section'],
      additionalProperties: false,
    },
    async execute({ paper_ids, to_section }) {
      const target = resolveSection(to_section);
      if (!target) fail(`Unknown section "${to_section}".`);
      const moved = paper_ids.filter((id) => store.movePaper(id, target.id));
      return { moved_count: moved.length, to_section: target.title };
    },
  }),

  tool({
    name: 'remove_papers',
    title: 'Remove papers from workspace',
    description: 'Remove papers from the canvas. Destructive: the human sees removals immediately and can undo only by re-adding.',
    inputSchema: {
      type: 'object',
      properties: { paper_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } },
      required: ['paper_ids'],
      additionalProperties: false,
    },
    async execute({ paper_ids }) {
      const removed = paper_ids.filter((id) => store.removePaper(id));
      return { removed_count: removed.length, removed: removed };
    },
  }),

  tool({
    name: 'annotate_paper',
    title: 'Write a structured note',
    description:
      'Attach a structured note (summary | method | finding | limitation | connection | question) to a paper. ' +
      'Notes render on the canvas as first-class cards the human can edit or delete. Ground every note in the ' +
      'paper\'s abstract or details — do not speculate.',
    inputSchema: {
      type: 'object',
      properties: {
        paper_id: { type: 'string' },
        type: { type: 'string', enum: store.NOTE_TYPES },
        content: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['paper_id', 'type', 'content'],
      additionalProperties: false,
    },
    async execute({ paper_id, type, content }, { callId } = {}) {
      const note = store.annotatePaper(paper_id, { type, content, createdBy: 'agent', callId });
      if (!note) fail(`Paper ${paper_id} is not in the workspace.`);
      return { note_id: note.id, paper_id, type, editable_by_human: true };
    },
  }),

  tool({
    name: 'create_comparison',
    title: 'Gather comparison material',
    description:
      'Returns structured material (abstract excerpts, notes, metadata) for 2-6 papers so you can build a ' +
      'comparison. Analyze the material, then publish the table with save_artifact (kind: "comparison").',
    inputSchema: {
      type: 'object',
      properties: {
        paper_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
        dimensions: {
          type: 'array', items: { type: 'string' }, maxItems: 8,
          description: 'Suggested axes, e.g. ["method","benchmarks","key finding","limitations"]. You choose the final axes.',
        },
      },
    required: ['paper_ids'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, untrustedContentHint: true },
  async execute({ paper_ids, dimensions = null }) {
    const papers = paper_ids.map((id) => {
      const p = store.getPaper(id) ?? store.getState().inbox.find((x) => x.id === id);
      if (!p) fail(`Paper ${id} not found in workspace or inbox.`);
      return p;
    });
    return {
      suggested_dimensions: dimensions,
      papers: papers.map((p) => paperMaterial(p, { abstractChars: 900 })),
      next_step: 'You write the comparison — this tool only gathers the material. Analyze it, then publish the table as markdown with save_artifact (kind: "comparison").',
    };
  },
}),

  tool({
    name: 'find_connections',
    title: 'Find citation connections',
    description:
      'Computes pairwise relationships between workspace papers: shared foundational references, shared ' +
      'authors, shared topics. Deterministic citation-graph analysis, not guesswork. Defaults to all papers.',
    inputSchema: {
      type: 'object',
      properties: { paper_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12 } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute({ paper_ids = null }, { signal } = {}) {
      let papers = paper_ids
        ? paper_ids.map((id) => {
            const p = store.getPaper(id);
            if (!p) fail(`Paper ${id} is not in the workspace.`);
            return p;
          })
        : store.allPapers().slice(0, 12);
      if (papers.length < 2) fail('Need at least 2 papers (add some first).');
      const connections = await oa.findConnections(papers.map((p) => ({ ...p })), { signal });
      return {
        analyzed: papers.length,
        connections,
        next_step: 'Summarize the structure you see (clusters, bridges, isolates) for the human, or publish with save_artifact.',
      };
    },
  }),

  tool({
    name: 'identify_gaps',
    title: 'Identify corpus gaps',
    description:
      'Statistical gap analysis of the current workspace: topic frequency, co-occurrence sparsity, year and ' +
      'venue spread. Returns candidate gaps worth a targeted follow-up search.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async execute() {
      const analysis = oa.identifyGaps(store.allPapers());
      if (analysis.error) return analysis;
      return {
        ...analysis,
        next_step: 'Verify promising gaps with search_literature, then report or publish with save_artifact (kind: "gaps").',
      };
    },
  }),

  tool({
    name: 'draft_related_work',
    title: 'Gather draft material',
    description:
      'Gathers every paper and note in a section (default: all) as ground-truth material for writing a cited ' +
      'related-work section. Write the prose from ONLY this material, then publish with save_artifact (kind: "draft").',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Section title or id. Defaults to all sections.' },
        style: { type: 'string', enum: ['related-work', 'survey', 'blog'], description: 'Default related-work.' },
        max_papers: { type: 'integer', minimum: 2, maximum: 20 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute({ section = null, style = 'related-work', max_papers = 12 }) {
      const sec = section ? resolveSection(section) : null;
      if (section && !sec) fail(`Unknown section "${section}".`);
      let papers = sec ? store.getSectionPapers(sec.id) : store.allPapers();
      const totalAvailable = papers.length;
      papers = papers
        .sort((a, b) => (b.notes.length - a.notes.length) || (b.citedBy - a.citedBy))
        .slice(0, max_papers);
      if (papers.length < 2) fail('Need at least 2 papers with material before drafting.');
      return {
        workspace_title: store.getState().title,
        style,
        papers: papers.map((p) => paperMaterial(p, { abstractChars: 700 })),
        total_available: totalAvailable,
        truncated: totalAvailable > papers.length,
        citation_style: 'Cite inline as [Firstauthor Year] and list each cited paper_id at the end. Never cite papers absent from this material.',
      };
    },
  }),

  tool({
    name: 'save_artifact',
    title: 'Publish artifact to canvas',
    description:
      'Publish markdown you wrote (comparison table, gap analysis, related-work draft) as an artifact on the ' +
      'canvas. The human sees it immediately, can edit it, and can inspect which tool calls produced it. ' +
      'To revise an existing artifact after the human edits it: get_artifact first, incorporate their changes, ' +
      'then call this again with the same artifact_id.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', description: 'To UPDATE an existing artifact in place (preserving its position); omit to create a new one.' },
        kind: { type: 'string', enum: ['comparison', 'gaps', 'draft', 'summary'] },
        title: { type: 'string', maxLength: 120 },
        markdown: { type: 'string', minLength: 1, maxLength: 20000 },
        sources: { type: 'array', items: { type: 'string' }, description: 'Paper ids the content is grounded in.' },
      },
      required: ['kind', 'title', 'markdown'],
      additionalProperties: false,
    },
    async execute({ artifact_id = null, kind, title, markdown, sources = [] }, { callId } = {}) {
      const validSources = sources.filter((id) => store.getPaper(id));
      if (artifact_id) {
        const updated = store.updateArtifact(artifact_id, {
          title,
          markdown,
          callId,
          sources: validSources,
        });
        if (!updated) fail(`Unknown artifact "${artifact_id}" — get_workspace_state lists current ids.`);
        return {
          artifact_id: updated.id,
          updated_in_place: true,
          visible_to_human: true,
          sources_count: validSources.length,
          ignored_unknown_sources: sources.length - validSources.length,
        };
      }
      const artifact = store.addArtifact({
        kind, title, data: { markdown },
        createdBy: 'agent',
        callId,
        sources: validSources,
      });
      return {
        artifact_id: artifact.id,
        updated_in_place: false,
        visible_to_human: true,
        sources_count: validSources.length,
        ignored_unknown_sources: sources.length - validSources.length,
      };
    },
  }),

  tool({
    name: 'suggest_related',
    title: 'Suggest related papers',
    description:
      'Given a seed paper (default: most recently added), suggest related work — Semantic Scholar ' +
      'recommendations when available, OpenAlex relatedness + citations otherwise — excluding anything ' +
      'already in the workspace. Suggestions are staged in the Inbox.',
    inputSchema: {
      type: 'object',
      properties: { paper_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
      additionalProperties: false,
    },
    annotations: { untrustedContentHint: true },
    async execute({ paper_id = null, limit = 6 }, { signal } = {}) {
      let seed = paper_id ? store.getPaper(paper_id) : null;
      if (paper_id && !seed) seed = await oa.getWork(paper_id, signal);
      if (!seed) {
        const all = store.allPapers().sort((a, b) => b.addedAt - a.addedAt);
        if (!all.length) fail('Workspace is empty — pass an explicit paper_id.');
        seed = all[0];
      }
      const exclude = new Set([seed.id, ...store.allPapers().map((p) => p.id)]);
      let suggestions = [];
      let source = 'openalex';
      const doiHints = await scholar.recommendations(seed, { limit, signal });
      if (doiHints?.length) {
        const hydrated = await oa.hydrateByDois(doiHints.map((c) => c.doi), signal);
        suggestions = hydrated.filter((w) => !exclude.has(w.id));
        if (suggestions.length) source = 'semantic-scholar';
      }
      if (suggestions.length < 3) {
        const { suggestions: oaSugs } = await oa.suggestRelated(seed.id, { limit, excludeIds: [...exclude] });
        const seen = new Set(suggestions.map((w) => w.id));
        suggestions = suggestions.concat(oaSugs.filter((w) => !seen.has(w.id)));
      }
      suggestions = suggestions.slice(0, limit);
      store.setInbox(suggestions);
      return {
        seed: { id: seed.id, title: seed.title, year: seed.year },
        source,
        suggestion_count: suggestions.length,
        suggestions: suggestions.map(compact),
        next_step: 'Staged in the Inbox. add_papers to keep any of them.',
      };
    },
  }),

  tool({
    name: 'export_workspace',
    title: 'Export workspace',
    description: 'Export the full workspace as markdown (survey skeleton with notes and artifacts), BibTeX, or JSON. JSON is the shareable snapshot (activity log excluded). Large exports are truncated in the result — the human can always download the full file from the Export menu.',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['markdown', 'bibtex', 'json'] } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    async execute({ format = 'markdown' }) {
      const LIMIT = 18000;
      let content;
      if (format === 'bibtex') content = toBibtex();
      else if (format === 'json') {
        const s = store.getState();
        content = JSON.stringify({ ...s, activity: undefined }, null, 2);
      } else content = toMarkdown();
      const truncated = content.length > LIMIT;
      return {
        format,
        truncated,
        content: truncated ? `${content.slice(0, LIMIT)}\n\n…[truncated — use the app's Export menu for the full file]` : content,
      };
    },
  }),
];

export function toolByName(name) {
  return toolDefs.find((t) => t.name === name) ?? null;
}
