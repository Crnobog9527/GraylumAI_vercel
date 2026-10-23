/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Every tRPC hook returns an idle result, except the draft read, which says the conversation was deleted,
// and the topic workspace, which (from an earlier cache) still names a bound topic conversation.
const enabled: Record<string, boolean> = {};
let readData: unknown = { conversationDeleted: true, draftId: 'draft' };
const idle = { data: undefined, isLoading: false, isFetching: false, error: null, refetch: async () => ({}) };
const deep = (): unknown => new Proxy(() => undefined, { get: (_, key) => key === 'then' ? undefined : deep(), apply: () => undefined });
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_, area) => area === 'useUtils' ? () => deep() : new Proxy({}, { get: (_, procedure) => ({
    useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
      enabled[`${String(area)}.${String(procedure)}`] = options?.enabled !== false;
      if (area === 'opc' && procedure === 'read') return { ...idle, data: readData };
      if (area === 'opc' && procedure === 'topicWorkspace') return { ...idle, data: { bound: true, sessionId: 'topic-session' } };
      return idle;
    },
    useMutation: () => ({ mutate: () => undefined, mutateAsync: async () => ({}), isPending: false }),
  }) }) }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ draftId: 'draft' }), useRouter: () => ({ push() {}, replace() {} }) }));
// The archive gate is tested on its own (draft-archive-gate.test.tsx); here it only marks that it wraps the page.
vi.mock('../readonly-draft-view', () => ({ ReadonlyDraftView: () => <p>READONLY_VIEW</p>,
  RouteDraftArchiveGate: ({ children }: { children: React.ReactNode }) => <section data-archive-gate="">{children}</section>,
  retryUnlessMissing: () => false }));
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: () => <p>TOPICS_WORKSPACE</p> }));

describe('topics page of a draft whose conversation was deleted', () => {
  it('shows the read-only view instead of the topics workspace and its controls', async () => {
    const { default: Page } = await import('./page');
    const html = renderToStaticMarkup(<Page/>);
    expect(html).toContain('READONLY_VIEW');
    expect(html).not.toContain('TOPICS_WORKSPACE');
    // PAYWALL: the whole topics page sits behind the profile-archive gate.
    expect(html).toMatch(/^<section data-archive-gate="">/);
    // Nothing of the topic conversation is fetched or polled behind the read-only view.
    expect(enabled).toMatchObject({ 'opc.topicWorkspace': false, 'runtime.view': false, 'opc.topicDraft': false });
  }, 60_000); // The page module is large; its first import alone can take several seconds.

  it('starts no topic query while the draft read is still loading', async () => {
    readData = undefined;
    const { default: Page } = await import('./page');
    renderToStaticMarkup(<Page/>);
    expect(enabled).toMatchObject({ 'opc.topicWorkspace': false, 'runtime.view': false, 'opc.topicDraft': false });
  }, 60_000);
});
