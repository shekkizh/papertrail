# WebMCP Challenge — Submission Package

Everything below is ready to paste into the submission form. Live URL and repo are final;
only the video recording remains (script in README.md, replicated at the bottom).

---

## Live URL

**https://papertrail-six-weld.vercel.app**

Tested in: ChatGPT desktop browser / Codex (Site tools appear automatically), and Chrome with
`chrome://flags/#enable-webmcp-testing`. In any other browser the app still runs its tools
locally — the ⚙ Site tools panel, ▶ Guided demo, Share links, and ⟳ verification all work
without the flag. No authentication required.

## Repository

**https://github.com/shekkizh/papertrail** — MIT license (visible in the About section),
all source, 27/27 tests (`npm test`), zero dependencies, no build step.

`document.modelContext.registerTool` usage: `js/tools.js` defines 16 tools; `js/webmcp.js`
registers them on the top-level document with an AbortController signal, a state-dependent
registry (shared snapshots expose exactly 6 read tools), and `?embedOrigin=` cross-origin
delegation via `exposedTo`. Example tool, exactly as registered:

```js
document.modelContext.registerTool({
  name: "search_literature",
  title: "Search literature",
  description: "Search OpenAlex (250M+ scholarly works) by keyword. Results are staged in the app Inbox panel so the human can see them …",
  inputSchema: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer", minimum: 1, maximum: 15 }, from_year: { type: "integer" } }, required: ["query"], additionalProperties: false },
  annotations: { untrustedContentHint: true },
  execute: async ({ query, max_results = 8, from_year = null }, { signal }) => { /* … */ },
}, { signal });
```

## Text description (form answers)

**Why your use case is a strong fit for WebMCP**

Literature review is joint work: the human supplies taste and judgment; the machine supplies
reach and consistency. That only works if the agent operates the same workspace the researcher
sees — which is exactly what WebMCP enables and chat-sidebar scraping cannot. PaperTrail
exposes 16 typed tools over its real data model (search OpenAlex, read citation contexts from
Semantic Scholar, annotate, compare, find citation-graph connections, identify corpus gaps,
draft a cited related-work section, export). The agent gets structured ground truth instead of
pixels; the researcher keeps a canvas of editable objects instead of chat text to re-type.
Because the tools run in the page, every action is visible to the human the moment it happens —
the human-in-the-loop workflow WebMCP was designed for.

**How it creates a better user experience**

The agent's work lands as first-class canvas objects: cards, structured notes with typed icons
(summary/method/finding/limitation/connection/question), comparison tables, gap analyses,
drafted sections — each editable, movable, deletable, and badged by who made it. A live trail
strip shows every tool call as a colored dot. Every agent-written object carries a provenance
receipt; one click shows the exact tool call (inputs, outcome) that produced it, and ⟳ verify
re-fetches the artifact's sources from live OpenAlex and diffs them against stored metadata.
A share link encodes the whole workspace in the URL: the snapshot registers six read tools, so
a colleague's agent can audit the review's claims against its receipts; one click duplicates
the snapshot into the visitor's browser to edit. **Go live** takes the same workspace
cross-device: an op-log relay (Vercel function + Neon Postgres) replicates every human edit
and agent tool call to every open link within seconds, with a live peer count — your
collaborator's agent visibly working on your board, receipts attached.

**What people and agents can do together that was difficult or impossible before**

Seed two papers you trust; your agent reads them, writes grounded summary notes, computes
citation-graph connections, runs a statistical gap analysis over your corpus, drafts a cited
related-work section, and hands you a BibTeX export — while you drag a card to "Synthesized" or
fix one word of its draft mid-flight, and the agent (via `get_workspace_state` + `get_artifact`)
sees your edit and revises around it. Go live and hand the `?live=` link to a colleague on
another device: their edits — and their agent's tool calls — replicate onto your board in
seconds with receipts attached. Then a *second* agent audits the first: it loads the shared
workspace, checks each note against `get_citation_contexts`, and flags overreach — the human
arbitrates with the receipts on screen. Multi-device, multi-agent, receipt-backed research
workspaces did not exist before apps could expose their state model to the open web.

**How you implemented WebMCP (brief)**

Vanilla ES modules, no build step. `document.modelContext.registerTool` on the top-level
document (ChatGPT Site tools requirement) with an `AbortController` signal for unregistration;
honest annotations (`readOnlyHint` only on pure reads, `untrustedContentHint` on tools
returning third-party scholarly text); closed JSON Schemas enforced again server-side by a
validator. The spec's client APIs are exercised by the app itself: the guided demo agent
discovers tools with `getTools()` and executes them via `executeTool()` (through a spec-shaped
local shim when `modelContext` is absent), so the standard's full loop runs in any browser.
Shared snapshots re-register a reduced 6-tool read surface, optionally with `exposedTo` for
cross-origin host embedding (`embed/host.html` + `getTools({ fromOrigins })`). Tools are
DOM-free and node-tested against the live OpenAlex API plus a stubbed Semantic Scholar suite.

## Demo video (record ≤3 min — script)

Full shot list with timings lives in README.md. Beats: Site tools (16) → agent writes while
the live trail pulses → split-screen co-watch (drag in one window, agent writes in both) →
share link → second agent audits and catches the seeded overreach → ⟳ verify re-fetches
OpenAlex live → duplicate-and-fix (badge flips to *you*) → 5-second storefront flash ("same
130 lines, a different domain") → closing line: *"The next web isn't scraped by agents — it's
operated by them, with receipts. PaperTrail is one app; the pattern is for all of them."*

## Suggested judge walkthrough (Codex / ChatGPT browser)

1. "Search for recent papers on LLM agent communication failures and add the 5 most relevant
   to To Read, with a summary note for each grounded in its abstract snippet."
2. "What am I currently looking at in the inspector?"
3. "Write a finding and a limitation note for each paper in To Read, grounded in the abstracts."
4. "Compare them across method, benchmarks, and findings, and publish the table."
5. "How does the field actually cite the most-cited of these papers?"
6. "Draft the related-work section." → edit two sentences → "Read my draft back, keep my
   edits, and improve the rest."
7. "What's underexplored here? Propose gaps and verify one with a follow-up search."
8. "Export the survey as BibTeX." Then Share → audit the link from a second agent.
