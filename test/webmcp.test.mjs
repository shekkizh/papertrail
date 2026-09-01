// WebMCP native-bridge tests: real implementations diverge on executeTool's
// input form (Chrome docs: JSON string; Codex: parsed object). callTool must
// work against both, never double-execute a tool, and parse results whatever
// shape the build returns. The native bridge is exercised through a stubbed
// document.modelContext that enforces each build's validation.

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../js/state.js';
import { toolDefs } from '../js/tools.js';
import { webmcp, callTool } from '../js/webmcp.js';

function stubNativeBuild(mode) {
  const calls = [];
  const executeTool = async (tool, input) => {
    calls.push({ tool: tool.name, inputType: typeof input });
    if (mode === 'object-only' && (typeof input !== 'object' || input === null)) {
      throw new Error('WebMCP executeTool requires an object input.');
    }
    if (mode === 'string-only' && typeof input !== 'string') {
      throw new Error('executeTool input must be a valid JSON string.');
    }
    const parsed = typeof input === 'string' ? JSON.parse(input) : input;
    const def = toolDefs.find((t) => t.name === tool.name);
    return JSON.stringify(await def.execute(parsed, {}));
  };
  globalThis.document = {
    modelContext: {
      getTools: async () => toolDefs.map((t) => ({ name: t.name, annotations: t.annotations ?? {} })),
      executeTool,
      addEventListener() {},
    },
  };
  webmcp.mode = 'native';
  return calls;
}

test('native bridge: object-input build (Codex-style) works', async () => {
  store.init({ reset: true });
  const calls = stubNativeBuild('object-only');
  const ws = await callTool('get_workspace_state', {});
  assert.equal(ws.title, 'Untitled survey');
  assert.deepEqual(calls.map((c) => c.inputType), ['object'], 'object form used, no string fallback');
});

test('native bridge: string-input build (Chrome-docs-style) works via fallback', async () => {
  store.init({ reset: true });
  const calls = stubNativeBuild('string-only');
  const ws = await callTool('get_workspace_state', {});
  assert.equal(ws.title, 'Untitled survey');
  assert.deepEqual(calls.map((c) => c.inputType), ['object', 'string'],
    'object attempted first, string fallback after input rejection');
});

test('native bridge: write tool is NOT executed twice on input-form fallback', async () => {
  store.init({ reset: true });
  store.addPaper({ id: 'W8001', title: 'T', authors: [], year: 2024, venue: null, citedBy: 0, primaryTopic: null, topics: [], abstract: 'a' }, {});
  const calls = stubNativeBuild('string-only');
  const res = await callTool('annotate_paper', { paper_id: 'W8001', type: 'summary', content: 'grounded' });
  // the object attempt fails at INPUT VALIDATION (pre-execution); the tool
  // itself must run exactly once — on the string attempt
  assert.deepEqual(calls.map((c) => c.inputType), ['object', 'string']);
  assert.equal(res.note_id != null || typeof res.note_id === 'string', true);
  const paper = store.getPaper('W8001');
  assert.equal(paper.notes.length, 1, 'exactly one note — no double execution');
});

test('native bridge: results already parsed as objects pass through untouched', async () => {
  store.init({ reset: true });
  stubNativeBuild('object-only');
  // patch this build to return the object directly instead of a JSON string
  document.modelContext.executeTool = async (tool, input) => {
    const def = toolDefs.find((t) => t.name === tool.name);
    return def.execute(input, {});
  };
  const ws = await callTool('get_workspace_state', {});
  assert.equal(typeof ws, 'object');
  assert.equal(ws.title, 'Untitled survey');
});

test('native bridge: unknown tool still errors clearly', async () => {
  stubNativeBuild('object-only');
  await assert.rejects(() => callTool('nope_tool', {}), /not registered/);
});
