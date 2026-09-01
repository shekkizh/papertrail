# PaperTrail

**Your agent writes; another agent audits; receipts arbitrate.** PaperTrail is a literature-review canvas where your agent works the same board you do — its searches, notes, comparisons, and drafts land as editable objects on your canvas, each carrying a click-to-audit receipt of the exact tool call that produced it. Share the workspace and a *second* agent can audit the first one's claims against its receipts — then one click hands the board back to you to fix what the audit flagged. As a pattern, it's a reference implementation of auditable human-agent collaboration for any web app: expose your state model as typed read/write tools, log every call, let receipts arbitrate.

Live app: **https://papertrail-six-weld.vercel.app** *(WebMCP tools register automatically — open it in ChatGPT's browser or Codex, or Chrome with `chrome://flags/#enable-webmcp-testing` enabled)*

A survey-planning workspace for researchers — sections of paper cards, structured notes,
comparison tables, gap analyses, drafted related-work sections — with **16 structured tools on
`document.modelContext`**. Your agent reads and writes the app's real data model instead of
clicking through the UI blind; you watch it happen and keep the receipts.

Highlights:
- **Go live — cross-device collaboration**: hit ⚡ Go live and the workspace syncs across
  devices through an op-log relay (Vercel function + Neon Postgres). Open the `?live=` link
  anywhere — cards, notes, artifacts, *and agent tool calls* replicate to every screen in
  seconds, each carrying its provenance receipt. Your collaborator's agent becomes visible on
  your board as it works. The workspace id is the capability; offline behavior is unchanged
  (live is opt-in, local-first).
- **Steal the pattern**: [`pattern/`](./pattern/) extracts the whole design — typed tools on
  `document.modelContext`, a receipt ledger, provenance stamps on agent-written objects,
  re-runnable audits — into **~130 lines of zero-dependency code**, proven on a deliberately
  non-research domain: [a storefront demo](./pattern/demo.html) running the identical library.
  PaperTrail isn't just an app; it's a blueprint any canvas, dashboard, or storefront can adopt.
- **Live co-watch**: open the app in two windows of the same browser and both stay in sync in
  real time — drag a card in one and watch it land in the other, agent writes streaming into
  both. No backend needed for this tier; just the platform's `storage` events. Agent work is
  *watchable*, not hidden: the **live trail** strip shows every tool call as a dot colored by
  who made it.
- **Share links**: encode the whole workspace in the URL — the shared snapshot registers six
  read tools, so *another person's agent* can load, audit, and reason over your review. One
  click duplicates it into your own browser to make it editable. The share link itself *is* an
  agent-readable artifact. Embedded via [`embed/host.html`](./embed/host.html) with
  `?embedOrigin=`, the snapshot delegates those tools cross-origin (`exposedTo` +
  `getTools({ fromOrigins })`) — a journal site can host a review and hand its audit tools to
  the visitor's agent.
- **Receipt re-verification**: every artifact's grounded sources can be re-checked against live
  OpenAlex metadata with one click (⟳ verify) — provenance as evidence, not decoration.
- **Site tools explorer**: a human-visible panel (⚙ Site tools) listing exactly what any
  WebMCP agent discovers — names, schemas, and trust annotations.
- **The agent sees what you see**: `get_workspace_state` includes what you currently have
  selected; `get_artifact` returns an artifact's current text *including your edits* — so the
  agent can revise its own draft after you mark it up (`save_artifact` updates in place).

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

Registered in the top-level document via `document.modelContext.registerTool(tool, { signal })`.
Data comes from two keyless, CORS-open scholarly APIs: **OpenAlex** (the workspace's source of
record) and **Semantic Scholar** (an optional enrichment layer: TLDRs, citation contexts,
recommendations). Every S2 call degrades gracefully under rate limits — tools answer from
OpenAlex and say so — so the app never hard-fails in a demo.

| Tool | Kind | What it does |
| --- | --- | --- |
| `search_literature` | read* | Search OpenAlex (250M+ works); results stage in the shared Inbox with abstract snippets |
| `get_paper_details` | read | Full record: abstract, topics, venue, citations + S2 TLDR & open-access PDF |
| `get_workspace_state` | read | The agent sees the same canvas — including what the human has selected |
| `get_artifact` | read | An artifact's current text, human edits included |
| `get_citation_contexts` | read | Verbatim sentences other papers use to cite this one, with intents |
| `find_connections` | read | Deterministic citation-graph analysis: shared refs/authors/topics |
| `identify_gaps` | read | Statistical gap hypotheses from topic co-occurrence sparsity |
| `create_comparison` | read | Gathers grounded material for the agent to build a comparison |
| `draft_related_work` | read | Gathers cited material + citation-style contract for drafting |
| `suggest_related` | read | S2 recommendations, falling back to OpenAlex relatedness |
| `export_workspace` | read | Markdown survey skeleton / BibTeX / JSON |
| `add_papers` | write | Place cards + per-paper grounded notes in one call |
| `move_papers` | write | Move cards between sections |
| `remove_papers` | write | Remove cards |
| `annotate_paper` | write | Structured notes (summary/method/finding/limitation/connection/question) |
| `save_artifact` | write | Publish agent-authored artifacts — or revise one in place after human edits |

\* `search_literature` and `suggest_related` stage results into the human-visible Inbox, so
they honestly *do* mutate visible state and do not claim `readOnlyHint`. Tools returning
third-party scholarly text declare `untrustedContentHint`. Write tools are deliberately few
and concrete, so confirmation prompts stay meaningful. All schemas use closed
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
3. **Any browser**: click **▶ Guided demo** — a deterministic in-page agent (scripted, not an
   LLM) drives the same tools end-to-end so you can watch the mechanics, and every call lands
   in the auditable **Activity** tab. In ChatGPT's browser or Codex, a real model takes the
   driver's seat instead.
4. **Any browser, second person**: click **Share** — the link carries the whole workspace; the
   recipient's agent can immediately query the snapshot with six read tools. Or click
   **⚡ Go live** and share the `?live=` link — a full two-way collaboration session across
   devices, agents included.

Your workspace persists in `localStorage`. Nothing is sent anywhere except queries to the
OpenAlex and Semantic Scholar APIs.

## Implementation notes

- Zero dependencies, no build step: vanilla ES modules over two keyless CORS-open APIs
  (OpenAlex + Semantic Scholar). Deliberately serverless — the user's agent is the only LLM in
  the loop, the workspace never leaves the browser, and a judge's first visit can never hit a
  cold start. See PLAN.md for the full static-vs-backend rationale.
- `js/tools.js` is DOM-free, so `npm test` (Node's built-in runner) drives the exact tool
  definitions agents see — validation, live OpenAlex calls, provenance chains — plus a stubbed
  Semantic Scholar suite, snapshot-sanitization security tests, and live-sync op round-trips:
  30 tests total.
- `js/webmcp.js` registers natively when `document.modelContext` exists; otherwise installs a
  spec-shaped local shim (`registerTool`/`getTools`/`executeTool`) so the demo agent, UI, and
  tests exercise identical tool code in any environment.
- Live sync (`api/sync.js` + `js/sync.js`) is an opt-in op-log relay over Neon Postgres on
  Vercel: workspaces, a bigserial op sequence, and actor presence; the client drains its op
  outbox and applies remote ops idempotently. `tools/mock-server.mjs` serves the same API
  contract locally for offline testing. Everything else stays static and local-first.
- Registration uses an `AbortController` signal; tools run in the top-level document (required
  by ChatGPT Site tools); the page is origin-isolated static HTTPS.

## Run locally

```bash
python3 -m http.server 8347   # or: npm run serve
open http://localhost:8347
npm test                      # 24 end-to-end tests (live OpenAlex + stubbed S2)
```

## Deploy (Vercel)

Static — no build step. `vercel deploy --prod` from the repo root, or import the repo in the
Vercel dashboard with all defaults.

## Demo video script (≤3 min) — the audit story

The through-line: **agent A writes, agent B audits, receipts arbitrate.** Deliberately seed one
agent-written note with a soft overreach so the audit has something to catch.

1. 0:00 — Live URL in ChatGPT's browser; **Site tools** shows 16 registered tools (on screen).
2. 0:15 — Human seeds two papers they trust; prompt agent A: *"find recent work on agent
   communication failures, add the best 5 to To Read with summary notes"* → cards + notes land
   live; open one note's provenance popover. The **live trail** strip pulses with every call.
3. 0:50 — Agent A also writes a limitation note that slightly overreaches its evidence (seeded).
4. 1:00 — Split-screen moment: open a second window on the same workspace — drag a card in one
   window while the agent's writes stream into both (co-watch, no backend). Then click
   **Share** → open the link on a *second machine/browser*; the Site-tools indicator visibly
   registers the snapshot's 6 read tools — WebMCP firing on the shared page.
5. 1:20 — Agent B (Codex or a second ChatGPT session): *"this is a colleague's review — audit
   it: check the notes against their receipts and the citation contexts"* → it calls
   `get_workspace_state` + `get_citation_contexts`, flags the overreaching note.
6. 1:50 — Human clicks **⟳ verify** on an artifact: sources refetched from OpenAlex live,
   diffs shown. *"The audit is re-runnable, not decorative."*
7. 2:10 — **Duplicate to my browser** → the host edits the flagged note (badge flips to *you*).
8. 2:30 — Export BibTeX; show the **Activity** tab: every call, inputs, results. Flash
   [`pattern/demo.html`](./pattern/demo.html) for five seconds: *"same 130 lines, a storefront."*
   Close, over the split-screen: *"The next web isn't scraped by agents — it's operated by them,
   with receipts. PaperTrail is one app; the pattern is for all of them."*

Production tips: pre-record agent A's half so model latency doesn't burn the clock; keep the
share-page tool registration moment in full view; the audit must catch something real.

## License

MIT — see [LICENSE](LICENSE).
