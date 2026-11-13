/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ image: vi.fn(), status: vi.fn() }));
vi.mock('@/trpc/client', () => ({ trpc: { connectors: { shotvivaImage: { useQuery: mocks.image }, shotvivaStatus: { useQuery: mocks.status } } } }));
import { ImageStepCards } from './image-step-cards';
import { mergeStep, stepLine } from './turn-step-list-model';

const JOB = '00000000-0000-4000-8000-0000000000bb';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.image.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mocks.status.mockReturnValue({ data: undefined });
});

describe('image cards under a reply', () => {
  it('a made image shows through Graylum (never the signed address) with a link to its Shotviva page', () => {
    mocks.image.mockReturnValue({ data: { status: 'succeeded', viewUrl: `https://shotviva.test/photos/${JOB}` }, isLoading: false, isError: false });
    const html = renderToStaticMarkup(<ImageStepCards steps={[{ id: '1', tool: 'image', state: 'done', job: JOB }]}/>);
    expect(html).toContain(`src="/api/connectors/shotviva/image?job=${JOB}"`);
    expect(html).toContain(`href="https://shotviva.test/photos/${JOB}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('r2.cloudflarestorage');
    expect(mocks.image).toHaveBeenCalledWith({ jobId: JOB }, expect.objectContaining({ enabled: true }));
  });

  it('a refused face swap says so with no button; out of credits offers Shotviva\'s top-up page', () => {
    const swap = renderToStaticMarkup(<ImageStepCards steps={[{ id: '1', tool: 'image', state: 'failed', reason: 'IDENTITY_SWAP_REFUSED' }]}/>);
    expect(swap).toContain('不支持换脸');
    expect(swap).not.toContain('<a');
    expect(mocks.image).toHaveBeenCalledWith({ jobId: '' }, expect.objectContaining({ enabled: false }));
    mocks.status.mockReturnValue({ data: { balance: { topUpUrl: 'https://shotviva.test/pricing?from=graylum' } } });
    const quota = renderToStaticMarkup(<ImageStepCards steps={[{ id: '1', tool: 'image', state: 'failed', reason: 'quota_exhausted' }]}/>);
    expect(quota).toContain('href="https://shotviva.test/pricing?from=graylum"');
    expect(quota).toContain('去 Shotviva 充值');
  });

  it('not connected goes to the integrations page; other steps and a running image step show no card', () => {
    const html = renderToStaticMarkup(<ImageStepCards steps={[{ id: '1', tool: 'image', state: 'skipped', reason: 'not_linked' }]}/>);
    expect(html).toContain('href="/app/integrations"');
    expect(renderToStaticMarkup(<ImageStepCards steps={[{ id: '1', tool: 'research', state: 'done' },
      { id: '2', tool: 'image', state: 'running' }]}/>)).toBe('');
  });

  it('the step line and the merge keep the job', () => {
    expect(stepLine({ id: '1', tool: 'image', state: 'running' })).toBe('正在用 Shotviva 生成图片…');
    expect(stepLine({ id: '1', tool: 'image', state: 'done', job: JOB })).toBe('已生成图片');
    expect(stepLine({ id: '1', tool: 'image', state: 'failed', reason: 'content_rejected' })).toBe('图片没有生成');
    expect(mergeStep([{ id: '1', tool: 'image', state: 'running' }], { id: '1', tool: 'image', state: 'done', job: JOB }))
      .toEqual([{ id: '1', tool: 'image', state: 'done', job: JOB }]);
  });
});
