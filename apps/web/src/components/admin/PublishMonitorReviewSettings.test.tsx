/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock('@/trpc/client', () => ({ trpc: {
  publishMonitor: { review: { adminSettings: { useQuery: () => state.settings },
    saveAdminSettings: { useMutation: () => ({ mutateAsync: async () => ({}), isPending: false, error: null }) } } },
  settings: { getSummaryModels: { useQuery: () => ({ data: [{ id: 'm-primary', name: '对话模型', available: true, reason: null },
    { id: 'm-own', name: '专用模型', available: true, reason: null }] }) } },
} }));
import { PublishMonitorReviewSettings } from './PublishMonitorReviewSettings';

const render = (data: unknown) => { state.settings = { isLoading: false, data, refetch: () => {} }; return renderToStaticMarkup(<PublishMonitorReviewSettings />); };
const selected = (html: string) => html.match(/<option value="([^"]*)"[^>]*selected/)?.[1];

describe('review settings form', () => {
  it('keeps "沿用对话模型" selected when the effective model is only inherited, so saving other fields does not pin it', () => {
    const html = render({ enabled: true, modelId: 'm-primary', ownModelId: null, maxCostUsd: '0.30' });
    expect(selected(html) ?? '').toBe('');
  });
  it('selects the dedicated model an admin chose', () => {
    expect(selected(render({ enabled: true, modelId: 'm-own', ownModelId: 'm-own', maxCostUsd: '0.30' }))).toBe('m-own');
  });
});
