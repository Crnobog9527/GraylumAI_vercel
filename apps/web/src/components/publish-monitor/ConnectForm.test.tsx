/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/trpc/client', () => ({ trpc: {
  opc: { businesses: { useQuery: () => ({ data: [], isLoading: false, error: null }) } },
  publishMonitor: {
    addAccount: { useMutation: () => ({ error: null, isPending: false, mutate: vi.fn() }) },
    connectTikhub: { useMutation: () => ({ error: null, data: null, isPending: false, mutate: vi.fn() }) } } } }));
import { ConnectForm, startPostForMe } from './ConnectForm';
import type { Brand } from './brands';

const brand = (platform: string): Brand => ({ businessId: 'b', name: '甲', accounts: [{ projectId: 'p', platform,
  label: 'me', businessId: 'b', businessName: '甲', items: [] }] });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
afterEach(() => { vi.unstubAllGlobals(); });

it('lets the user ask for publishing on the platforms whose consent needs the connect form (regression)', () => {
  for (const platform of ['instagram', 'facebook', 'linkedin', 'bluesky']) {
    const html = renderToStaticMarkup(<ConnectForm brands={[brand(platform)]} connected={new Set()} initialProjectId="p"
      onConnected={() => {}} />);
    expect(text(html)).toContain('同时允许一键发布');
    expect(text(html)).toContain('只请求读取作品数据');
  }
});

it('starts with publishing ticked when opened to add publishing to an account', () => {
  const html = renderToStaticMarkup(<ConnectForm brands={[brand('instagram')]} connected={new Set()} initialProjectId="p"
    initialPublish onConnected={() => {}} />);
  expect(text(html)).toContain('会请求读取作品数据和发布权限');
  expect(html).toContain('aria-checked="true"');
});

it('sends the publishing choice to the start route', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ url: 'https://auth.example/x' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const assign = vi.fn();
  await startPostForMe({ accountProjectId: 'p', publish: true, connectionType: 'facebook' }, assign);
  expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
    .toEqual({ accountProjectId: 'p', publish: true, connectionType: 'facebook' });
  expect(assign).toHaveBeenCalledWith('https://auth.example/x');
});
