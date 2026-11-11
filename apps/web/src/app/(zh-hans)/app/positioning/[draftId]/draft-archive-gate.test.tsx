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
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: ({ area, children }: { area: string; children: unknown }) => <div data-frame={area}>{children as never}</div> }));
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
    // The draft page's gate frames the placeholder as "chat", the topics page's route gate as "topics" (the finished pages' areas).
    for (const [index, html] of (await render()).entries()) { expect(html).toContain(`data-frame="${index ? 'topics' : 'chat'}"`); expect(html).toContain('page-skeleton'); expect(html).not.toContain('正在读取'); expect(html).not.toContain('EDITABLE'); }
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

  it('leaves a deleted conversation and a failed draft read to the page itself, whatever the profiles say', async () => {
    // The profiles were asked for with the draft (see the test below), so an answer may be there. It is not used:
    // pending, archived or unreadable, the page (which shows these two cases itself) is what opens.
    const answers: Result[] = [{ isPending: true, isSuccess: false, isError: false, error: null }, ok(profile(true)), ok(profile(false)),
      { isPending: false, isSuccess: false, isError: true, error: new Error('down') }];
    for (const answer of answers) {
      businesses = answer;
      read = ok({ draftId: 'draft', conversationDeleted: true });
      for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
      read = { isPending: false, isSuccess: false, isError: true, error: new Error('x') };
      for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
    }
  });

  it('asks for the profiles together with the draft, not after it, and for nothing without a draft id', async () => {
    // While the draft read is still out, the profile read is already on: tRPC sends the two in one request.
    read = { isPending: true, isSuccess: false, isError: false, error: null };
    businesses = { isPending: true, isSuccess: false, isError: false, error: null };
    enabled.businesses = false;
    for (const html of await render()) { expect(html).toContain('page-skeleton'); expect(html).not.toContain('EDITABLE'); }
    expect(enabled.businesses).toBe(true);
    const { DraftArchiveGate } = await import('./draft-archive-gate');
    expect(renderToStaticMarkup(<DraftArchiveGate draftId=""><p>EDITABLE</p></DraftArchiveGate>)).toBe('<p>EDITABLE</p>');
    expect(enabled.businesses).toBe(false);
  });

  it('whichever read answers first, nothing opens before both have: then active opens the page and archived the read-only view', async () => {
    const pending: Result = { isPending: true, isSuccess: false, isError: false, error: null };
    for (const archived of [false, true]) {
      // The profiles first, the draft still out.
      read = pending; businesses = ok(profile(archived));
      for (const html of await render()) { expect(html).toContain('page-skeleton'); expect(html).not.toContain('EDITABLE'); expect(html).not.toContain('ARCHIVED_VIEW'); }
      // The draft first, the profiles still out.
      read = ok({ draftId: 'draft' }); businesses = pending;
      for (const html of await render()) { expect(html).toContain('page-skeleton'); expect(html).not.toContain('EDITABLE'); expect(html).not.toContain('ARCHIVED_VIEW'); }
      // Both in.
      businesses = ok(profile(archived));
      for (const html of await render()) {
        if (archived) { expect(html).toContain('ARCHIVED_VIEW'); expect(html).not.toContain('EDITABLE'); } else expect(html).toBe('<p>EDITABLE</p>');
      }
    }
    // Unreadable profiles, known before the draft is: still the placeholder, then the "try again" line, never the page.
    read = pending; businesses = { isPending: false, isSuccess: false, isError: true, error: new Error('down') };
    for (const html of await render()) { expect(html).toContain('page-skeleton'); expect(html).not.toContain('EDITABLE'); }
    read = ok({ draftId: 'draft' });
    for (const html of await render()) { expect(html).toContain('定位档案暂时读不出来'); expect(html).not.toContain('EDITABLE'); }
  });

  it('keeps the page mounted while its own read refetches a failed draft (no checking/unmount loop)', async () => {
    // A missing or someone else's draft: the page's read refetches on mount, so the query is pending again, no data.
    read = { isPending: true, isSuccess: false, isError: false, error: null, errorUpdatedAt: 2000, dataUpdatedAt: 0 };
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
    // A later successful read is newer than the failure: the archive check applies again.
    read = { ...ok({ draftId: 'draft' }), errorUpdatedAt: 2000, dataUpdatedAt: 3000 };
    businesses = { isPending: true, isSuccess: false, isError: false, error: null };
    for (const html of await render()) { expect(html).toContain('page-skeleton'); expect(html).not.toContain('正在读取'); }
  });

  it('still applies the archive check when a background refetch of a cached draft fails', async () => {
    const cachedThenFailed = { data: { draftId: 'draft' }, isPending: false, isSuccess: false, isError: true,
      error: new Error('down'), errorUpdatedAt: 3000, dataUpdatedAt: 2000 };
    read = cachedThenFailed;
    businesses = ok(profile(true));
    for (const html of await render()) { expect(html).toContain('ARCHIVED_VIEW'); expect(html).not.toContain('EDITABLE'); }
    businesses = ok(profile(false));
    for (const html of await render()) expect(html).toBe('<p>EDITABLE</p>');
  });
});
