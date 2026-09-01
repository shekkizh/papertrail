// WebMCP registration layer.
//
// Native path: tools are registered on document.modelContext in the top-level
// document, as ChatGPT's Site tools require. Progress:
// https://webmachinelearning.github.io/webmcp/
//
// Fallback path: when the browser doesn't expose document.modelContext yet (no
// testing flag, other browsers), we install a spec-shaped local shim so the
// in-page demo agent and the Site-tools explorer exercise the exact same tool
// code. The shim mirrors the spec surface: registerTool / getTools
// (alphabetical) / executeTool(jsonString).
//
// Share mode: a shared snapshot registers only its read tools — an auditor's
// agent can inspect a review without being able to mutate it.

import { toolDefs } from './tools.js';
import { isReadOnly } from './state.js';

const controller = new AbortController();

export const webmcp = {
  mode: 'node',            // 'native' | 'shim' | 'node'
  supported: false,
  registered: [],
  errors: [],
};

const shimRegistry = new Map();

// The read tools a shared snapshot exposes to any visiting agent.
const SHARE_TOOL_NAMES = new Set([
  'get_workspace_state', 'get_paper_details', 'get_artifact',
  'get_citation_contexts', 'find_connections', 'export_workspace',
]);

export function activeToolDefs() {
  return isReadOnly() ? toolDefs.filter((t) => SHARE_TOOL_NAMES.has(t.name)) : toolDefs;
}

export function shareToolCount() {
  return SHARE_TOOL_NAMES.size;
}

export function nativeAvailable() {
  return typeof document !== 'undefined' &&
    typeof document.modelContext?.registerTool === 'function';
}

async function registerNative() {
  webmcp.mode = 'native';
  webmcp.supported = true;
  // Embedded snapshots can delegate their read tools to a host page: a share
  // URL opened with ?embedOrigin=<host origin> registers with exposedTo, so
  // the host can discover them via getTools({ fromOrigins }). Spec:
  // https://webmachinelearning.github.io/webmcp/
  const embedOrigin = isReadOnly()
    ? new URLSearchParams(location.search).get('embedOrigin')
    : null;
  const validEmbed = embedOrigin && (() => { try { return new URL(embedOrigin).origin === embedOrigin; } catch { return false; } })();
  for (const def of activeToolDefs()) {
    try {
      if (validEmbed) {
        await document.modelContext.registerTool(def, { signal: controller.signal, exposedTo: [embedOrigin] });
      } else {
        await document.modelContext.registerTool(def, { signal: controller.signal });
      }
      webmcp.registered.push(def.name);
    } catch (err) {
      webmcp.errors.push({ name: def.name, message: String(err?.message ?? err) });
    }
  }
  try {
    document.modelContext.addEventListener('toolchange', () => {
      document.dispatchEvent(new CustomEvent('papertrail:toolschanged'));
    });
  } catch { /* older builds without event support */ }
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
  for (const def of activeToolDefs()) shimRegistry.set(def.name, def);
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

export async function getRegistryForExplorer() {
  if (webmcp.mode === 'native') {
    try {
      return (await document.modelContext.getTools()).map((t) => ({
        name: t.name, title: t.title, description: t.description,
        inputSchema: t.inputSchema, annotations: t.annotations ?? {},
      }));
    } catch {
      return activeToolDefs().map(toExplorerShape);
    }
  }
  return activeToolDefs().map(toExplorerShape);
}

function toExplorerShape(def) {
  return {
    name: def.name, title: def.title, description: def.description,
    inputSchema: def.inputSchema, annotations: def.annotations ?? {},
  };
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
