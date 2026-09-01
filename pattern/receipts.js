// receipts.js — drop-in WebMCP provenance for any web app. Zero dependencies.
//
// The pattern PaperTrail is built on, in ~130 lines:
//   1. expose your app's state model as typed tools on document.modelContext
//   2. log every call (inputs + outcome) to a receipt ledger
//   3. stamp every object an agent writes with the callId that produced it
//   4. render the ledger so the human can audit; re-verify claims on demand
//
// Usage (see demo.html):
//   import { defineReceiptedTools, attachLedger } from './receipts.js';
//   const { calls, stamp } = defineReceiptedTools({
//     name: 'my-app',
//     tools: [{ name, title, description, inputSchema, execute }]
//   });
//   attachLedger(document.querySelector('#ledger'), { app: 'my-app' });
//
// Then in your write tools: return { receipt: stamp() } and store it on the
// object you created — the UI links any object back to its exact tool call.

const SHIM_NOTE =
  'document.modelContext is unavailable in this browser, so tools run through a local stand-in.';

function nowIso() { return new Date().toISOString(); }

function summaryOf(result) {
  if (result === undefined) return null;
  if (typeof result === 'string') return result.slice(0, 140);
  try {
    const s = JSON.stringify(result);
    return s.length > 140 ? `${s.slice(0, 140)}…` : s;
  } catch {
    return null;
  }
}

export function defineReceiptedTools({ name = 'app', storageKey = `receipts.${name}.v1`, tools }) {
  if (!Array.isArray(tools) || !tools.length) {
    throw new TypeError('defineReceiptedTools: tools[] required');
  }
  const load = () => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]'); } catch { return []; }
  };
  const save = (calls) => {
    try { localStorage.setItem(storageKey, JSON.stringify(calls.slice(-200))); } catch { /* quota */ }
  };

  let calls = typeof localStorage !== 'undefined' ? load() : [];
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(calls); } catch { /* isolated */ } } };

  function record(tool, input) {
    const callId = `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    calls = [...calls, { id: callId, ts: Date.now(), tool, input: input ?? {}, ok: null, summary: null }];
    save(calls);
    emit();
    return callId;
  }
  function complete(callId, summary, ok) {
    calls = calls.map((c) => (c.id === callId ? { ...c, summary, ok } : c));
    save(calls);
    emit();
  }

  // A per-execution receipt factory, injected into execute() via options —
  // never a global, so parallel tool calls can't stamp each other's receipts.
  function makeStamp(callId) {
    return () => ({ callId, at: nowIso(), by: 'agent' });
  }

  const receipted = tools.map((tool) => ({
    ...tool,
    annotations: tool.annotations ?? {},
    execute: async (input, options) => {
      const callId = record(tool.name, input);
      try {
        const result = await tool.execute(input ?? {}, { ...(options ?? {}), stamp: makeStamp(callId) });
        complete(callId, summaryOf(result), true);
        return result;
      } catch (err) {
        complete(callId, String(err?.message ?? err), false);
        throw err;
      }
    },
  }));

  const native = typeof document !== 'undefined' &&
    typeof document.modelContext?.registerTool === 'function';

  const shim = !native
    ? (() => {
        const registry = new Map();
        const shimObj = {
          async registerTool(def) { registry.set(def.name, def); document.dispatchEvent(new CustomEvent('receipts:toolschanged')); },
          async getTools() { return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name)); },
          async executeTool(ref, jsonInput) {
            const def = registry.get(typeof ref === 'string' ? ref : ref?.name);
            if (!def) throw new Error(`Unknown tool: ${ref?.name ?? ref}`);
            return JSON.stringify(await def.execute(JSON.parse(jsonInput || '{}'), {}));
          },
        };
        for (const def of receipted) registry.set(def.name, def);
        try { document.modelContext = shimObj; } catch { /* read-only in some embeds */ }
        return shimObj;
      })()
    : null;

  async function register() {
    const errors = [];
    if (native) {
      for (const def of receipted) {
        try { await document.modelContext.registerTool(def); } catch (err) { errors.push({ name: def.name, message: String(err) }); }
      }
    }
    return { mode: native ? 'native' : 'shim', registered: receipted.map((t) => t.name), errors, note: native ? undefined : SHIM_NOTE };
  }

  async function callTool(name, input) {
    const tool = receipted.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    if (native) {
      const registered = await document.modelContext.getTools();
      const found = registered.find((t) => t.name === name);
      if (!found) throw new Error(`Tool ${name} not registered`);
      return JSON.parse(await document.modelContext.executeTool(found, JSON.stringify(input ?? {})));
    }
    return shim.executeTool(name, JSON.stringify(input ?? {}));
  }

  // Re-verify: re-run a recorded READ-ONLY call and compare its outcome with
  // the recorded summary. Write tools are refused — re-running them would
  // mutate app state, which an auditor must never do.
  async function verifyCall(callId) {
    const entry = calls.find((c) => c.id === callId);
    if (!entry) return { ok: false, note: 'no such call' };
    const tool = tools.find((t) => t.name === entry.tool);
    if (!tool?.annotations?.readOnlyHint) {
      return { ok: false, note: 'write tool — refusing to re-run; audit its inputs in the ledger instead' };
    }
    const before = entry.summary;
    try {
      const result = await callTool(entry.tool, entry.input);
      const after = summaryOf(result);
      return { ok: true, stable: before === after, before, after, at: nowIso() };
    } catch (err) {
      return { ok: false, note: String(err?.message ?? err) };
    }
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function getCalls() { return calls; }

  return { register, callTool, verifyCall, getCalls, onChange, mode: native ? 'native' : 'shim' };
}

// Minimal ledger UI: a <details> list of every call with a Verify button.
export function attachLedger(el, { app = 'app' } = {}) {
  if (!el) return null;
  el.innerHTML = '<p class="receipts-hint">No tool calls yet.</p>';
  let api = null;
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const render = (calls) => {
    if (!calls.length) return;
    el.innerHTML = calls
      .slice()
      .reverse()
      .map((c) => `
        <div class="receipt" data-call="${esc(c.id)}">
          <div class="receipt-head">
            <code>${esc(c.tool)}</code>
            <span class="receipt-ok ${c.ok === false ? 'bad' : 'good'}">${c.ok === false ? 'failed' : 'ok'}</span>
            <time>${esc(new Date(c.ts).toLocaleTimeString())}</time>
          </div>
          <pre>${esc(String(JSON.stringify(c.input, null, 1)).slice(0, 300))}</pre>
          ${c.summary ? `<div class="receipt-sum">${esc(String(c.summary).slice(0, 160))}</div>` : ''}
          <button class="receipt-verify" data-verify="${esc(c.id)}">⟳ re-verify</button>
          <span class="receipt-result" data-result="${esc(c.id)}"></span>
        </div>`)
      .join('');
  };
  el.addEventListener('click', async (e) => {
    const id = e.target?.dataset?.verify;
    if (!id || !api) return;
    const out = el.querySelector(`[data-result="${id}"]`);
    out.textContent = '…';
    const res = await api.verifyCall(id);
    out.textContent = res.ok
      ? (res.stable ? '✓ stable' : `~ changed → ${String(res.after ?? '').slice(0, 80)}`)
      : `✕ ${res.note}`;
  });
  return {
    bind(receiptsApi) {
      api = receiptsApi;
      render(receiptsApi.getCalls());
      receiptsApi.onChange(render);
    },
  };
}
