// WebMCP registration layer.
//
// Native path: every tool is registered on document.modelContext (top-level document,
// as ChatGPT's Site tools require). Progress: https://webmachinelearning.github.io/webmcp/
//
// Fallback path: when the browser doesn't expose document.modelContext yet (no testing
// flag, non-Chrome browser), we install a spec-shaped local shim so the in-page demo
// agent and the UI exercise the exact same tool code. The shim mirrors the spec surface
// the demo client uses: registerTool / getTools (alphabetical) / executeTool(jsonString).

import { toolDefs } from './tools.js';

const controller = new AbortController();

export const webmcp = {
  mode: 'node',            // 'native' | 'shim' | 'node'
  supported: false,
  registered: [],
  errors: [],
};

const shimRegistry = new Map();

export function nativeAvailable() {
  return typeof document !== 'undefined' &&
    typeof document.modelContext?.registerTool === 'function';
}

async function registerNative() {
  webmcp.mode = 'native';
  webmcp.supported = true;
  for (const def of toolDefs) {
    try {
      await document.modelContext.registerTool(def, { signal: controller.signal });
      webmcp.registered.push(def.name);
    } catch (err) {
      webmcp.errors.push({ name: def.name, message: String(err?.message ?? err) });
    }
  }
  document.modelContext.addEventListener('toolchange', () => {
    document.dispatchEvent(new CustomEvent('papertrail:toolschanged'));
  });
}

// Minimal spec-shaped stand-in used only when the real API is unavailable.
function installShim() {
  webmcp.mode = 'shim';
  const shim = {
    async registerTool(def) {
      if (!def?.name || !def?.description || typeof def.execute !== 'function') {
        throw new TypeError('Invalid tool definition');
      }
      shimRegistry.set(def.name, def);
      document.dispatchEvent(new CustomEvent('papertrail:toolschanged'));
    },
    async getTools() {
      return [...shimRegistry.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((def) => ({ ...def, origin: location.origin, window }));
    },
    async executeTool(toolRef, jsonInput, { signal } = {}) {
      const def = typeof toolRef === 'string' ? shimRegistry.get(toolRef) : shimRegistry.get(toolRef?.name);
      if (!def) throw new Error(`Unknown tool: ${toolRef?.name ?? toolRef}`);
      return JSON.stringify(await def.execute(JSON.parse(jsonInput || '{}'), { signal }));
    },
  };
  for (const def of toolDefs) shimRegistry.set(def.name, def);
  document.modelContext = shim;
}

export function callTool(name, input) {
  if (webmcp.mode === 'native') {
    // Route through the browser's own dispatch so the demo agent exercises the
    // exact path an external agent uses (including serialization).
    return (async () => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((t) => t.name === name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return JSON.parse(await document.modelContext.executeTool(tool, JSON.stringify(input ?? {})));
    })();
  }
  const def = shimRegistry.get(name);
  if (!def) throw new Error(`Tool ${name} not registered`);
  return def.execute(input ?? {}, {});
}

export async function setupWebMCP() {
  if (typeof document === 'undefined') return webmcp;
  if (nativeAvailable()) {
    await registerNative();
  } else {
    installShim();
  }
  document.dispatchEvent(new CustomEvent('papertrail:ready', { detail: webmcp }));
  return webmcp;
}

export function toolSummary() {
  return {
    mode: webmcp.mode,
    count: webmcp.registered.length || toolDefs.length,
    errors: webmcp.errors,
  };
}
