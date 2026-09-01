// UI-only selection state (which paper is open in the inspector, which tab).
let sel = { paperId: null, tab: 'paper' };
const listeners = new Set();

export function getSelection() { return sel; }

export function select(paperId) {
  sel = { ...sel, paperId };
  emit();
}

export function setTab(tab) {
  sel = { ...sel, tab };
  emit();
}

function emit() { for (const fn of listeners) fn(sel); }

export function onSelect(fn) { listeners.add(fn); }
