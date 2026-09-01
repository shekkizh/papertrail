# The receipts pattern — steal this

PaperTrail is one instance of a general design for agent-native web apps. This folder is the
pattern, extracted: **~130 lines of zero-dependency code** that make any web app operable by
any WebMCP agent while keeping the human in command.

## The four moves

1. **Expose your state model as tools.** Not UI automation — typed `read`/`write` operations on
   the data the app actually runs on, registered on `document.modelContext` in the top-level
   document.
2. **Ledger every call.** Tool name, inputs, outcome — an append-only receipt trail.
3. **Stamp what the agent writes.** Every object an agent creates or modifies carries the
   `callId` that touched it. Provenance becomes a property of the data, not a chat log.
4. **Make the audit re-runnable.** Any receipt can be re-executed through the live registered
   tools and compared with the recorded outcome. Provenance as evidence, not decoration.

## Use it

```html
<script type="module">
  import { defineReceiptedTools, attachLedger } from './receipts.js';

  const { register, callTool, verifyCall, getCalls, onChange } = defineReceiptedTools({
    name: 'my-app',
    tools: [ /* { name, title, description, inputSchema, execute } */ ],
  });
  await register();                       // native WebMCP, or a spec-shaped local stand-in
  attachLedger(document.querySelector('#ledger')).bind({ getCalls, onChange, verifyCall });
  // inside a write tool: execute(input, { stamp }) { obj.receipt = stamp(); }
  // → the object now carries its provenance; verifyCall re-runs reads only
</script>
```

Open [`demo.html`](./demo.html) for a complete one-file **storefront** using it — four tools
(add/remove/get/checkout), receipts on every cart line, a ledger with re-verify that refuses to
re-execute writes. It is deliberately *not* a research app: the identical 130 lines that power
PaperTrail's literature review power a shop. In ChatGPT's browser or Chrome with
`chrome://flags/#enable-webmcp-testing`, the agent discovers the tools automatically; in any
other browser the demo still runs and the pattern is still visible.

## Why this matters for the open web

The app remains the source of truth; the agent gets a typed, audited API instead of pixel
guessing; the human gets a paper trail instead of trust-me. Any canvas, dashboard, editor, or
storefront can adopt the same four moves — WebMCP supplies the discovery, receipts supply the
trust. PaperTrail's full implementation (per-note provenance, live cross-view sync,
share-link snapshots with reduced read-only tool surfaces, live re-verification against
OpenAlex) shows the pattern at product scale.
