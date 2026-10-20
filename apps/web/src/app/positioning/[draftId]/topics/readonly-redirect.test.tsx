/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Every tRPC hook returns an idle result, except the draft read, which says the conversation was deleted,
// and the topic workspace, which (from an earlier cache) still names a bound topic conversation.
const enabled: Record<string, boolean> = {};
let readData: unknown = { conversationDeleted: true, draftId: 'draft' };
// PAYWALL profile archive: opc.businesses lists each profile's drafts and whether it is archived.
let archived = false;
const idle = { data: undefined, isLoading: false, isFetching: false, error: null, refetch: async () => ({}) };
const deep = (): unknown => new Proxy(() => undefined, { get: (_, key) => key === 'then' ? undefined : deep(), apply: () => undefined });
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_, area) => area === 'useUtils' ? () => deep() : new Proxy({}, { get: (_, procedure) => ({
    useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
      enabled[`${String(area)}.${String(procedure)}`] = options?.enabled !== false;
      if (area === 'opc' && procedure === 'read') return { ...idle, data: readData };
      if (area === 'opc' && procedure === 'topicWorkspace') return { ...idle, data: { bound: true, sessionId: 'topic-session' } };
      if (area === 'opc' && procedure === 'businesses') return { ...idle,
        data: [{ businessId: 'b', name: '账号', archivedAt: null, isArchived: archived, drafts: [{ draftId: 'draft' }] }] };
      return idle;
    },
    useMutation: () => ({ mutate: () => undefined, mutateAsync: async () => ({}), isPending: false }),
  }) }) }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ draftId: 'draft' }), useRouter: () => ({ push() {}, replace() {} }) }));
vi.mock('../readonly-draft-view', async original => ({ ...await original<object>(),
  ReadonlyDraftView: ({ archived: shown }: { archived?: boolean }) => <p>{shown ? 'ARCHIVED_VIEW' : 'READONLY_VIEW'}</p> }));
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: () => <p>TOPICS_WORKSPACE</p> }));

describe('topics page of a draft whose conversation was deleted', () => {
  it('shows the read-only view instead of the topics workspace and its controls', async () => {
    const { default: Page } = await import('./page');
    const html = renderToStaticMarkup(<Page/>);
    expect(html).toContain('READONLY_VIEW');
    expect(html).not.toContain('TOPICS_WORKSPACE');
    // Nothing of the topic conversation is fetched or polled behind the read-only view.
    expect(enabled).toMatchObject({ 'opc.topicWorkspace': false, 'runtime.view': false, 'opc.topicDraft': false });
  }, 60_000); // The page module is large; its first import alone can take several seconds.

  it('shows the archived read-only view for a draft whose profile was archived', async () => {
    readData = { draftId: 'draft', sessionId: 'session' };
    archived = true;
    const { default: Page } = await import('./page');
    const html = renderToStaticMarkup(<Page/>);
    expect(html).toContain('ARCHIVED_VIEW');
    expect(html).not.toContain('TOPICS_WORKSPACE');
    archived = false;
    expect(renderToStaticMarkup(<Page/>)).not.toContain('ARCHIVED_VIEW');
  }, 60_000);

  it('starts no topic query while the draft read is still loading', async () => {
    readData = undefined;
    const { default: Page } = await import('./page');
    renderToStaticMarkup(<Page/>);
    expect(enabled).toMatchObject({ 'opc.topicWorkspace': false, 'runtime.view': false, 'opc.topicDraft': false });
  }, 60_000);
});
