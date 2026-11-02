/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// A topic workspace bound to v9 of a positioning whose formal version has moved on to v10: it is read-only and says so.
let current = 'v10';
const idle = { data: undefined, isLoading: false, isFetching: false, error: null, refetch: async () => ({}) };
const deep = (): unknown => new Proxy(() => undefined, { get: (_, key) => key === 'then' ? undefined : deep(), apply: () => undefined });
vi.mock('@/trpc/client', () => ({
  trpc: new Proxy({}, { get: (_, area) => area === 'useUtils' ? () => deep() : new Proxy({}, { get: (_, procedure) => ({
    useQuery: () => {
      if (area === 'opc' && procedure === 'read') return { ...idle, data: { draftId: 'draft', report: { available: true, id: current }, plans: [], handoffs: [] } };
      if (area === 'opc' && procedure === 'topicWorkspace') return { ...idle, data: { bound: true, sessionId: 'topic-session', sourceVersionId: 'v9', sourceAllowed: true } };
      return idle;
    },
    useMutation: () => ({ mutate: () => undefined, mutateAsync: async () => ({}), isPending: false }),
  }) }) }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ draftId: 'draft' }), useRouter: () => ({ push() {}, replace() {} }) }));
vi.mock('../readonly-draft-view', () => ({ ReadonlyDraftView: () => <p>READONLY_VIEW</p>,
  RouteDraftArchiveGate: ({ children }: { children: React.ReactNode }) => <>{children}</>, retryUnlessMissing: () => false }));
vi.mock('@/components/opc/workspace-frame', () => ({ WorkspaceFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

describe('topics page of a workspace bound to an older positioning version', () => {
  it('shows the notice and a way to the latest positioning, without a raw error code', async () => {
    const { default: Page } = await import('./page');
    const html = renderToStaticMarkup(<Page/>);
    expect(html).toContain('你已更新过正式定位');
    expect(html).toContain('/app/positioning/draft');
    expect(html).not.toContain('OPC_');
  }, 60_000);
  it('shows no notice while the workspace is on the current version', async () => {
    current = 'v9';
    const { default: Page } = await import('./page');
    expect(renderToStaticMarkup(<Page/>)).not.toContain('你已更新过正式定位');
  }, 60_000);
});
