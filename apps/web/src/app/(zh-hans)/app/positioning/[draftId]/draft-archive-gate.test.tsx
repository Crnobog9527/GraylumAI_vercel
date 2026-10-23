/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data?: unknown; error?: unknown; isPending?: boolean; isSuccess?: boolean; isError?: boolean;
  errorUpdatedAt?: number; dataUpdatedAt?: number };
let read: Result;
let businesses: Result;
const enabled: Record<string, boolean> = {};
vi.mock('@/trpc/client', () => ({
  trpc: { opc: {
    read: { useQuery: () => read },
    businesses: { useQuery: (_input: unknown, options: { enabled?: boolean }) => {
      enabled.businesses = options.enabled !== false;
      return { ...businesses, refetch: async () => ({}) };
    } },
  } },
}));
vi.mock('./readonly-draft-view', () => ({ ReadonlyDraftView: ({ archived }: { archived?: boolean }) => <p>{archived ? 'ARCHIVED_VIEW' : 'X'}</p> }));
vi.mock('next/navigation', () => ({ useParams: () => ({ draftId: 'draft' }) }));

const profile = (isArchived: boolean) => [{ businessId: 'b', name: '账号', archivedAt: null, isArchived, drafts: [{ draftId: 'draft' }] }];
const ok = (data: unknown): Result => ({ data, isPending: false, isSuccess: true, isError: false, error: null });

async function render() {
  const { DraftArchiveGate, RouteDraftArchiveGate } = await import('./draft-archive-gate');
  return [renderToStaticMarkup(<DraftArchiveGate draftId="draft"><p>EDITABLE</p></DraftArchiveGate>),
    renderToStaticMarkup(<RouteDraftArchiveGate><p>EDITABLE</p></RouteDraftArchiveGate>)];
}

describe('profile-archive gate in front of the editable draft and topics pages', () => {
  beforeEach(() => { read = ok({ draftId: 'draft' }); businesses = ok(profile(false)); });

  it('opens the editable page only for a confirmed active profile', async () => {
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
  });

  it('shows the archived read-only view and never mounts the editable page', async () => {
    businesses = ok(profile(true));
    for (const html of await render()) { expect(html).toContain('ARCHIVED_VIEW'); expect(html).not.toContain('EDITABLE'); }
  });

  it('keeps the editable page closed while the archive state is unknown or unreadable', async () => {
    businesses = { isPending: true, isSuccess: false, isError: false, error: null };
    for (const html of await render()) { expect(html).toContain('正在读取定位档案'); expect(html).not.toContain('EDITABLE'); }
    businesses = { isPending: false, isSuccess: false, isError: true, error: new Error('down') };
    for (const html of await render()) {
      expect(html).toContain('定位档案暂时读不出来');
      expect(html).toContain('重试');
      expect(html).not.toContain('EDITABLE');
    }
    read = { isPending: true, isSuccess: false, isError: false, error: null };
    businesses = ok(profile(false));
    for (const html of await render()) expect(html).not.toContain('EDITABLE');
  });

  it('leaves a deleted conversation and a failed draft read to the page itself, without reading profiles', async () => {
    read = ok({ draftId: 'draft', conversationDeleted: true });
    businesses = { isPending: true, isSuccess: false, isError: false, error: null };
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
    expect(enabled.businesses).toBe(false);
    read = { isPending: false, isSuccess: false, isError: true, error: new Error('x') };
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
  });

  it('keeps the page mounted while its own read refetches a failed draft (no checking/unmount loop)', async () => {
    // A missing or someone else's draft: the page's read refetches on mount, so the query is pending again, no data.
    read = { isPending: true, isSuccess: false, isError: false, error: null, errorUpdatedAt: 2000, dataUpdatedAt: 0 };
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
    // A later successful read is newer than the failure: the archive check applies again.
    read = { ...ok({ draftId: 'draft' }), errorUpdatedAt: 2000, dataUpdatedAt: 3000 };
    businesses = { isPending: true, isSuccess: false, isError: false, error: null };
    for (const html of await render()) expect(html).toContain('正在读取定位档案');
  });
});
