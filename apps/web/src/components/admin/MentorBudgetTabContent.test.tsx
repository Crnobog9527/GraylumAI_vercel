/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MutationOptions = { onSuccess: (data: unknown) => Promise<void> };

// Static rendering cannot re-render after a state update, so the component's useState is backed by a
// store that survives between renders. Each render replays the hooks in order against the same slots.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
const trpcState = vi.hoisted(() => ({
  view: undefined as unknown,
  queries: 0,
  mutationOptions: undefined as MutationOptions | undefined,
  setData: undefined as ((...args: unknown[]) => void) | undefined,
  invalidate: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof import('react')>()),
  useState: (initial: unknown) => {
    const slot = hooks.index++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (next: unknown) => { hooks.slots[slot] = next; }];
  },
}));

vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ mentorBudget: { get: { setData: trpcState.setData, invalidate: trpcState.invalidate } } }),
    mentorBudget: {
      get: { useQuery: () => { trpcState.queries += 1; return { data: trpcState.view, error: null, refetch: vi.fn() }; } },
      update: {
        useMutation: (options: MutationOptions) => {
          trpcState.mutationOptions = options;
          return { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null };
        },
      },
    },
  },
}));

import { Tabs } from '@/components/ui/tabs';
import { MENTOR_BUDGET_TAB, MentorBudgetTabContent } from './MentorBudgetSettings';
import { toBudgetDraft } from './mentorBudgetDraft';
import { configuredView } from './mentorBudgetFixtures';

/** Read through a call so TypeScript does not keep the `undefined` narrowed before a render. */
const capturedMutation = (): MutationOptions | undefined => trpcState.mutationOptions;

function renderTab(tab: string) {
  hooks.index = 0;
  return renderToStaticMarkup(
    createElement(Tabs, { value: tab }, createElement(MentorBudgetTabContent, { onOpenFeatures: vi.fn() })),
  );
}

describe('MentorBudgetTabContent', () => {
  beforeEach(() => {
    hooks.slots = [];
    trpcState.view = configuredView;
    trpcState.queries = 0;
    trpcState.mutationOptions = undefined;
    trpcState.setData = vi.fn();
    trpcState.invalidate = vi.fn(async () => undefined);
  });

  it('owns the save request even while the budget tab is unmounted', () => {
    renderTab('features');
    expect(trpcState.queries).toBe(0);
    expect(trpcState.mutationOptions).toBeDefined();
  });

  it('keeps the draft across a tab switch, then clears it and shows the saved note when the save succeeds', async () => {
    renderTab(MENTOR_BUDGET_TAB);
    const base = toBudgetDraft(configuredView);
    hooks.slots[0] = { ...base, interactive: { ...base.interactive, inputBytes: '50000' } }; // draft slot
    expect(renderTab(MENTOR_BUDGET_TAB)).toMatch(/data-testid="mentor-budget-interactive-inputBytes"[^>]*value="50000"/);

    // The success callback must come from the render where the budget tab is unmounted.
    trpcState.mutationOptions = undefined;
    renderTab('features');
    const options = capturedMutation(); // set by the render above
    expect(options).toBeDefined();
    await options?.onSuccess(configuredView);
    expect(trpcState.setData).toHaveBeenCalledWith(undefined, configuredView);
    expect(trpcState.invalidate).toHaveBeenCalled();

    const markup = renderTab(MENTOR_BUDGET_TAB);
    expect(markup).toMatch(/data-testid="mentor-budget-interactive-inputBytes"[^>]*value="64000"/);
    expect(markup).toContain('已保存，并已重新读取服务端的配置。');
  });
});
