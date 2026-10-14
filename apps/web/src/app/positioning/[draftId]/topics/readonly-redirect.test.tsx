/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Every tRPC hook returns an idle result, except the draft read, which says the conversation was deleted,
// and the topic workspace, which (from an earlier cache) still names a bound topic conversation.
const enabled: Record<string, boolean> = {};
const idle = { data: undefined, isLoading: false, isFetching: false, error: null, refetch: async () => ({}) };
const deep = (): unknown => new Proxy(() => undefined, { get: (_, key) => key === 'then' ? undefined : deep(), apply: () => undefined });
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_, area) => area === 'useUtils' ? () => deep() : new Proxy({}, { get: (_, procedure) => ({
    useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
      enabled[`${String(area)}.${String(procedure)}`] = options?.enabled !== false;
      if (area === 'opc' && procedure === 'read') return { ...idle, data: { conversationDeleted: true, draftId: 'draft' } };
      if (area === 'opc' && procedure === 'topicWorkspace') return { ...idle, data: { bound: true, sessionId: 'topic-session' } };
      return idle;
    },
    useMutation: () => ({ mutate: () => undefined, mutateAsync: async () => ({}), isPending: false }),
  }) }) }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ draftId: 'draft' }), useRouter: () => ({ push() {}, replace() {} }) }));
vi.mock('../readonly-draft-view', () => ({ ReadonlyDraftView: () => <p>READONLY_VIEW</p> }));
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
});
