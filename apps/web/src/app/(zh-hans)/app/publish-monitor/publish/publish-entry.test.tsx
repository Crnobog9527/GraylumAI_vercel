/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const state = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: { publishMonitor: { publish: { options: { useQuery: () => ({ data: state.data }) } } } } }));
import { PublishEntry } from './publish-entry';

const ITEM = '00000000-0000-4000-8000-000000000d01';
const html = (finalized: boolean) => renderToStaticMarkup(<PublishEntry workItemId={ITEM} finalized={finalized} />);
beforeEach(() => { state.data = { platforms: ['x'], holdCreditsByTargets: null }; });

it('links to the publish page only for a final draft, an open platform and a plan the server accepted', () => {
  expect(html(true)).toContain(`/app/publish-monitor/publish?item=${ITEM}`);
  expect(html(false)).toBe('');
  state.data = { platforms: [], holdCreditsByTargets: null };
  expect(html(true)).toBe('');
  state.data = undefined; // free plan, feature off, or still loading
  expect(html(true)).toBe('');
});
