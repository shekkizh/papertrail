# PaperTrail — Project Plan

**One-liner.** A literature-review canvas where a researcher and their AI agent work the same
workspace at the same time: the human curates and judges, the agent searches, extracts,
compares, and drafts — through structured WebMCP tools instead of blind UI guessing.

**Why this wins on the criteria**

- *WebMCP leverage* — 14 purpose-built tools covering the full read → write → analyze →
  synthesize spectrum over rich shared state. The agent doesn't scrape the page; it operates
  the app's real data model. State reads (`get_workspace_state`) mean the agent always knows
  what the human is looking at; state writes mean agent actions materialize in the UI instantly.
- *Execution* — zero-dependency static app, live scholarly data (OpenAlex), localStorage
  persistence, and an in-page demo agent built on the spec's own `getTools()`/`executeTool()`
  client APIs so the full experience works even where the `modelContext` object is unavailable.
- *Impact* — every researcher does literature review; nobody enjoys the copy-paste churn
  between chat windows and reference managers. This is a daily-use tool, not a demo toy.
- *Creativity* — **provenance receipts**: every agent-written note/artifact records the tool
  call chain that produced it, surfaced in the UI ("how was this made?"). Agent output you can
  audit is the missing ingredient for trust in human-agent co-work. It also fits the app's
  name: a real paper trail.

**Human + agent division of labor (the "impossible before" bit)**

| Human (UI) | Agent (WebMCP tools) |
| --- | --- |
| Judges relevance, drags papers between sections | Searches OpenAlex with structured queries |
| Edits/deletes any agent note in place | Extracts abstracts, topics, citation counts |
| Renames sections, seeds examples | Builds comparison tables, finds citation connections |
| Verifies claims against sources via provenance | Identifies corpus gaps, drafts cited prose |

Before WebMCP the agent saw neither your workspace nor the effect of its actions — it dumped
text into a chat and you re-typed it into your tools. Here both parties see and shape one
shared artifact, live.

**Tool surface (the submission's core — 16 tools)**

Read: `search_literature`, `get_paper_details`, `get_workspace_state` (includes the human's
live selection), `get_artifact`, `suggest_related`, `find_connections`, `identify_gaps`,
`create_comparison`, `draft_related_work`, `get_citation_contexts`, `export_workspace`
Write: `add_papers` (with per-paper notes), `move_papers`, `remove_papers`, `annotate_paper`,
`save_artifact` (create or revise-in-place after human edits).

**Ambition features beyond the core loop**

- *Share links*: workspace serialized (gzip+base64) into the URL hash; a shared snapshot
  registers six read tools so another person's agent can audit and reason over the review.
  Cross-session, cross-agent collaboration with zero backend.
- *Site tools explorer*: in-app panel showing the live tool registry (names, schemas,
  annotations) — WebMCP made visible to human visitors.
- *Provenance receipts*: every agent note/artifact links to the exact tool call; planned:
  re-verification (refetch the source and diff stored vs live data).

**Architecture**

```
index.html
js/state.js      workspace store: sections, papers, notes, artifacts, activity; pub/sub; localStorage
js/openalex.js   OpenAlex client (CORS-enabled, keyless) + abstract reconstruction
js/tools.js      the 14 WebMCP tools (DOM-free, testable in Node)
js/webmcp.js     registration via document.modelContext.registerTool; spec-shaped local shim
                 fallback so demo agent + tests exercise identical code paths
js/ui/*.js       board, search, inspector, activity log, demo agent (in-page WebMCP client)
test/            node --test suite hitting the real OpenAlex API through tools.js
```

Deployment: Vercel (static, no build; origin-isolated HTTPS satisfies the WebMCP security
model). Why static and not a backend: the user's agent is the only LLM in the loop — a server
would duplicate it; the workspace never leaves the browser; a judge's first visit can't hit a
cold start or an auth wall. The one real client-side gap (full-text reading) is partially
closed with CORS-open Semantic Scholar enrichment instead. Testing: `npm test` (21 tests —
tools + live OpenAlex + stubbed Semantic Scholar) plus the in-page demo agent as an
end-to-end harness.

**Demo video beats (≤3 min)**
1. Open the live URL in ChatGPT's browser → "Site tools: 14 available" (0:00–0:20)
2. Human seeds workspace with 2 known papers, drags between sections (0:20–0:40)
3. Agent: "find recent work on agent communication failures and add the top 5" → cards appear (0:40–1:10)
4. Agent: compare 3 papers → comparison artifact; open provenance popover (1:10–1:50)
5. Agent: "what's missing in my survey?" → gap analysis (1:50–2:20)
6. Agent: draft a related-work section → editable cited draft; human edits one sentence (2:20–2:50)
7. Export workspace as markdown + BibTeX (2:50–3:00)
