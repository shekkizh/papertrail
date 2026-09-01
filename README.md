# PaperTrail

**A literature-review canvas where you and your AI agent work the same workspace, at the same time.**

Live app: **https://shekkizh.github.io/papertrail/** *(WebMCP tools register automatically — open it in ChatGPT's browser, or Chrome with `chrome://flags/#enable-webmcp-testing` enabled)*

PaperTrail is a survey-planning board for researchers: sections of paper cards, structured
notes, comparison tables, gap analyses, drafted related-work sections. What makes it new is
that the app registers **14 structured tools on `document.modelContext`**, so your agent
doesn't click through the UI blind — it reads and writes the app's real data model, with every
action materializing on your canvas instantly and every agent-written object carrying
**provenance back to the exact tool call that produced it**.

---

## Why this needs WebMCP

Literature review is a *joint* activity: the human supplies taste and judgment; the machine
supplies reach and consistency. Until now an agent could only do its half in a chat sidebar and
hand you text to re-type into your tools. With WebMCP:

- **Shared state.** The agent calls `get_workspace_state` and sees exactly what you see — your
  sections, cards, and notes are its context. No re-explaining, no copy-paste.
- **Visible, structured actions.** When the agent calls `add_papers` or `annotate_paper`, cards
  and notes appear on the canvas as first-class objects you can edit, move, or delete — not
  chat text you must transcribe.
- **Trust through provenance.** Every agent note/artifact stores the tool call that produced it.
  Click *"provenance — how this was made"* to see the tool, its inputs, and its result. Agent
  output you can audit is the missing ingredient for real human-agent co-work.
- **The app is both server and client.** PaperTrail registers tools for external agents, and its
  built-in **guided demo agent** consumes the same tools through the spec's client APIs
  (`getTools()` / `executeTool()`). The standard's whole loop — serve tools, discover tools,
  call tools — runs inside one page.

**What people and agents do together that was hard before:** you seed two papers you already
trust; your agent reads them, writes grounded summary/limitation notes, compares them along
dimensions you name, computes citation-graph connections, runs a statistical gap analysis over
your corpus, drafts a cited related-work section, and hands you a BibTeX export — while you
drag a card to "Synthesized" or fix one word in its draft, mid-flight. Neither party could do
the other's half before.

## The tool surface

Registered in the top-level document via `document.modelContext.registerTool(tool, { signal })`:

| Tool | Kind | What it does |
| --- | --- | --- |
| `search_literature` | read | Search OpenAlex (250M+ works); results stage in the shared Inbox |
| `get_paper_details` | read | Full record: abstract, topics, venue, citations, existing notes |
| `get_workspace_state` | read | The agent sees the same canvas the human sees |
| `find_connections` | read | Deterministic citation-graph analysis: shared refs/authors/topics |
| `identify_gaps` | read | Statistical gap hypotheses from topic co-occurrence sparsity |
| `create_comparison` | read | Gathers grounded material for the agent to build a comparison |
| `draft_related_work` | read | Gathers cited material + citation-style contract for drafting |
| `suggest_related` | read | Related work via OpenAlex relatedness + citations, minus what you have |
| `export_workspace` | read | Markdown survey skeleton / BibTeX / JSON |
| `add_papers` | write | Place cards on the canvas (instantly visible to the human) |
| `move_papers` | write | Move cards between sections |
| `remove_papers` | write | Remove cards |
| `annotate_paper` | write | Structured notes (summary/method/finding/limitation/connection/question) |
| `save_artifact` | write | Publish agent-authored tables/drafts as editable canvas artifacts |

Read tools declare `annotations: { readOnlyHint: true }`; write tools are deliberately few and
concrete, so confirmation prompts stay meaningful. All schemas use closed
`additionalProperties`, enums, and length bounds.

## Try it

1. **ChatGPT desktop app** (GPT-5.6 Sol/Terra): open the live URL in the built-in browser →
   the **Site tools** indicator shows PaperTrail's tools → prompt away, e.g.
   - *"Search for recent papers on LLM agent communication failures and add the 5 most
     relevant to To Read, with a summary note each."*
   - *"Compare everything in Reading across method, benchmarks, and findings."*
   - *"What's underexplored in my corpus? Propose gaps and a follow-up search for each."*
   - *"Draft a related-work section from my notes, then export the survey as BibTeX."*
2. **Chrome** with `chrome://flags/#enable-webmcp-testing` enabled.
3. **Any browser**: click **▶ Guided demo** — the in-page agent drives the same tools
   end-to-end (search → add → annotate → compare → gaps → connections → draft) and you can
   audit every call in the **Activity** tab.

Your workspace persists in `localStorage`. Nothing leaves your browser except OpenAlex queries.

## Implementation notes

- Zero dependencies, no build step: vanilla ES modules + OpenAlex REST (CORS-enabled, keyless).
  Static hosting keeps the whole tool surface client-side and auditable.
- `js/tools.js` is DOM-free, so `npm test` (Node's built-in runner) drives the exact tool
  definitions agents see — validation, live OpenAlex calls, provenance chains — in 16 tests.
- `js/webmcp.js` registers natively when `document.modelContext` exists; otherwise installs a
  spec-shaped local shim (`registerTool`/`getTools`/`executeTool`) so the demo agent, UI, and
  tests exercise identical tool code in any environment.
- Registration uses an `AbortController` signal; tools run in the top-level document (required
  by ChatGPT Site tools); the page is origin-isolated static HTTPS.

## Run locally

```bash
python3 -m http.server 8347   # or: npm run serve
open http://localhost:8347
npm test                      # 16 end-to-end tests against live OpenAlex
```

## Demo video script (≤3 min)

1. 0:00 — Live URL in ChatGPT's browser; **Site tools** shows 14 registered tools.
2. 0:20 — Human seeds two known papers, drags one to *Reading*, renames a section.
3. 0:40 — Prompt: "find recent work on agent communication failures, add the top 5 to To Read
   with summary notes" → cards + notes appear live; open one note's *provenance* popover.
4. 1:20 — Prompt: "compare them across method/benchmarks/findings" → `create_comparison` +
   `save_artifact` → table artifact renders; human edits one cell's wording.
5. 1:50 — Prompt: "what's underexplored?" → `identify_gaps` → gap artifact; agent proposes a
   follow-up `search_literature`.
6. 2:20 — Prompt: "draft the related-work section" → cited draft artifact; human tweaks a
   sentence (note the badge flip from *agent* to *you*).
7. 2:45 — Export → BibTeX; open the **Activity** tab: the full auditable tool-call trail.

## License

MIT — see [LICENSE](LICENSE).
