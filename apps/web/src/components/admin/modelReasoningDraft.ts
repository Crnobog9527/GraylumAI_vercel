/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  allowedModes,
  allowedWires,
  REASONING_PURPOSES,
  type CatalogSnapshot,
  type PurposeSetting,
  type ReasoningPurpose,
} from '@repo/api/src/shared/modelReasoning';

export type Wire = 'reasoning_effort' | 'reasoning';
/** One purpose's form state; `unset` stores nothing for that purpose. */
export type Draft = { mode: 'unset' | PurposeSetting['mode']; effort: string; wire: Wire; budget: string };

export function toDraft(setting: PurposeSetting | undefined, defaultWire: Wire): Draft {
  if (!setting) return { mode: 'unset', effort: '', wire: defaultWire, budget: '' };
  return {
    mode: setting.mode,
    effort: setting.mode === 'effort' ? setting.effort : '',
    wire: setting.mode === 'off' || setting.mode === 'effort' ? setting.wire : defaultWire,
    budget: setting.mode === 'budget' ? String(setting.maxTokens) : '',
  };
}
export function fromDraft(draft: Draft): PurposeSetting | undefined {
  switch (draft.mode) {
    case 'unset':
      return undefined;
    case 'provider_default':
      return { mode: 'provider_default' };
    case 'off':
      return { mode: 'off', wire: draft.wire };
    case 'effort':
      return { mode: 'effort', effort: draft.effort as Extract<PurposeSetting, { mode: 'effort' }>['effort'], wire: draft.wire };
    case 'budget':
      return { mode: 'budget', maxTokens: Number(draft.budget) };
  }
}
/** Reconcile editable values on initial load and route/catalog changes. */
export function normalizeDrafts(
  drafts: Record<ReasoningPurpose, Draft>,
  catalog: CatalogSnapshot | null,
  route: string | null,
): Record<ReasoningPurpose, Draft> {
  const wires = allowedWires(catalog, route);
  let next = drafts;
  for (const purpose of REASONING_PURPOSES) {
    const draft = drafts[purpose];
    const mode = draft.mode === 'unset' || allowedModes(catalog, route, purpose).includes(draft.mode)
      ? draft.mode : 'unset';
    const wire = wires.includes(draft.wire) ? draft.wire : (wires[0] ?? draft.wire);
    if (mode !== draft.mode || wire !== draft.wire) {
      if (next === drafts) next = { ...drafts };
      next[purpose] = { ...draft, mode, wire };
    }
  }
  return next;
}
