/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import {
  checkReasoningConfig,
  REASONING_PURPOSES,
  type CatalogSnapshot,
  type PurposeSettings,
  type ReasoningPurpose,
} from '@repo/api/src/shared/modelReasoning';
import { fromDraft, normalizeDrafts, toDraft, type Draft } from './modelReasoningDraft';

const catalog: CatalogSnapshot = {
  fetchedAt: '2026-09-29T00:00:00.000Z',
  model: 'example/model',
  reasoning: {
    mandatory: false, defaultEnabled: false, supportedEfforts: ['low', 'high'],
    defaultEffort: 'low', supportsMaxTokens: true,
  },
  endpoints: [
    { tag: 'effort', providerName: 'Effort', supportedParameters: ['tools', 'reasoning_effort'], contextLength: 8192, maxCompletionTokens: 8192 },
    { tag: 'object', providerName: 'Object', supportedParameters: ['tools', 'reasoning'], contextLength: 8192, maxCompletionTokens: 8192 },
    { tag: 'both', providerName: 'Both', supportedParameters: ['tools', 'reasoning_effort', 'reasoning'], contextLength: 8192, maxCompletionTokens: 8192 },
    { tag: 'notools', providerName: 'No tools', supportedParameters: ['reasoning'], contextLength: 8192, maxCompletionTokens: 8192 },
    { tag: 'plain', providerName: 'Plain', supportedParameters: ['tools'], contextLength: 8192, maxCompletionTokens: 8192 },
  ],
};
function drafts(mode: 'off' | 'effort' = 'off'): Record<ReasoningPurpose, Draft> {
  return Object.fromEntries(REASONING_PURPOSES.map(purpose => [purpose, toDraft(
    mode === 'off' ? { mode, wire: 'reasoning_effort' } : { mode, wire: 'reasoning_effort', effort: 'high' },
    'reasoning_effort',
  )])) as Record<ReasoningPurpose, Draft>;
}
function saved(draft: Record<ReasoningPurpose, Draft>): PurposeSettings {
  const purposes: PurposeSettings = {};
  for (const purpose of REASONING_PURPOSES) {
    const setting = fromDraft(draft[purpose]);
    if (setting) purposes[purpose] = setting;
  }
  return purposes;
}
function expectSavable(draft: Record<ReasoningPurpose, Draft>, snapshot: CatalogSnapshot | null, route: string | null) {
  expect(checkReasoningConfig({ catalog: snapshot, route, purposes: saved(draft) }, {
    modelId: catalog.model, maxTokens: 8192,
  })).toEqual([]);
}

describe('reasoning draft capability changes', () => {
  it.each(['off', 'effort'] as const)('replaces unsupported wires for all purposes in %s mode on route changes', mode => {
    const initial = drafts(mode);
    const object = normalizeDrafts(initial, catalog, 'object');
    for (const purpose of REASONING_PURPOSES) {
      expect(object[purpose]).toEqual({ ...initial[purpose], wire: 'reasoning' });
      expect(initial[purpose].wire).toBe('reasoning_effort');
    }
    expectSavable(object, catalog, 'object');
    const effort = normalizeDrafts(object, catalog, 'effort');
    expect(effort).toEqual(initial);
    expectSavable(effort, catalog, 'effort');
  });

  it('replaces unsupported stored wires on initial load without changing the saved setting', () => {
    const stored = { mode: 'effort', effort: 'high', wire: 'reasoning_effort' } as const;
    const initial = drafts();
    initial.interactive = toDraft(stored, 'reasoning');
    expect(saved(normalizeDrafts(initial, catalog, 'object')).interactive)
      .toEqual({ ...stored, wire: 'reasoning' });
    expect(stored.wire).toBe('reasoning_effort');
  });

  it('uses the first allowed wire when a catalog refresh changes the selected route', () => {
    const refreshed: CatalogSnapshot = {
      ...catalog,
      endpoints: catalog.endpoints.map(endpoint => endpoint.tag === 'effort'
        ? { ...endpoint, supportedParameters: ['tools', 'reasoning'] } : endpoint),
    };
    const next = normalizeDrafts(drafts('effort'), refreshed, 'effort');
    for (const purpose of REASONING_PURPOSES) expect(next[purpose].wire).toBe('reasoning');
    expectSavable(next, refreshed, 'effort');
  });

  it('keeps valid edits and avoids changing a supported wire to another supported wire', () => {
    const initial = normalizeDrafts(drafts('effort'), catalog, 'object');
    expect(normalizeDrafts(initial, catalog, 'both')).toBe(initial);
    expect(normalizeDrafts(initial, catalog, 'object')).toBe(initial);
    expectSavable(initial, catalog, 'both');
  });

  it('unsets only the interactive purpose on a route without tools', () => {
    const next = normalizeDrafts(drafts(), catalog, 'notools');
    expect(next.interactive.mode).toBe('unset');
    for (const purpose of ['organize', 'review', 'writing'] as const) {
      expect(next[purpose].mode).toBe('off');
      expect(next[purpose].wire).toBe('reasoning');
    }
    expectSavable(next, catalog, 'notools');
    // Returning to a capable route does not silently revive the discarded choice.
    expect(normalizeDrafts(next, catalog, 'object').interactive.mode).toBe('unset');
  });

  it.each([null, catalog])('unsets all purposes before a route is selected (catalog: %j)', snapshot => {
    const next = normalizeDrafts(drafts(), snapshot, null);
    expect(saved(next)).toEqual({});
    expectSavable(next, snapshot, null);
  });

  it('does not keep unsupported modes selected when reasoning support disappears', () => {
    const next = normalizeDrafts(drafts(), catalog, 'plain');
    expect(saved(next)).toEqual({});
    expectSavable(next, catalog, 'plain');
    const noReasoning = { ...catalog, reasoning: null };
    expect(saved(normalizeDrafts(drafts(), noReasoning, 'effort'))).toEqual({});
  });
});
