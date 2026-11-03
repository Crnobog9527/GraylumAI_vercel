/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { chatImages, imageMark, withImages } from './chatImage';
import { CHAT_MAX_IMAGES, JPEG_DATA_URL_PREFIX } from './provider/imageInput';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound } from './provider/openRouterPolicy';
import { syntheticJpeg } from '../__tests__/fixtures/syntheticJpeg';

const url = (width: number, height: number, filler = 0) => JPEG_DATA_URL_PREFIX
  + Buffer.concat([syntheticJpeg(width, height).subarray(0, -2), Buffer.alloc(filler, 7), Buffer.from([0xff, 0xd9])]).toString('base64');

describe('chat images', () => {
  it('are 1 to 4 JPEGs, each within LIB-2d limits: 614,400 bytes and 2048 px a side, short side 64, at most 4:1', () => {
    expect(chatImages([url(1170, 2048)])).toMatchObject([{ width: 1170, height: 2048, url: url(1170, 2048) }]);
    expect(chatImages(Array(CHAT_MAX_IMAGES).fill(url(800, 600)))).toHaveLength(4);
    expect(chatImages(Array(CHAT_MAX_IMAGES + 1).fill(url(800, 600)))).toBeNull();
    expect(chatImages([])).toBeNull();
    for (const bad of [url(2049, 1000), url(1000, 1000, 614_400), url(1, 1), url(100, 500),
      'data:image/png;base64,' + Buffer.from('png').toString('base64'), JPEG_DATA_URL_PREFIX + 'not base64', 'https://example.com/a.jpg'])
      expect(chatImages([url(800, 600), bad])).toBeNull();
  });

  it('are marked "[截图] " for one and "[截图×N] " for several', () => {
    expect(imageMark(1)).toBe('[截图] ');
    expect(imageMark(3)).toBe('[截图×3] ');
  });

  it('join only the current (last) user message, after its text, in order', () => {
    const history = { type: 'message', role: 'user', content: 'earlier' }, current = { type: 'message', role: 'user', content: imageMark(2) + '看图' };
    expect(withImages([history, current], ['data:a', 'data:b'])).toEqual([history, { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: imageMark(2) + '看图' }, { type: 'input_image', image: 'data:a' }, { type: 'input_image', image: 'data:b' }] }]);
  });
});

describe('the OpenRouter adapter and a turn-core chat image', () => {
  const limits = { providerSlug: 'anthropic', contextTokens: 200_000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' };
  const identity = (imageUsd: string | undefined, imageInput?: { maxDataUrlBytes: number; maxEdge: number }) => {
    const providerLimits = { ...limits, ...(imageUsd === undefined ? {} : { imageUsd }) };
    return { provider: 'openrouter', account: 'test', model: 'anthropic/claude-sonnet-5.5', protocol: 'openrouter-chat-v1' as const,
      providerLimits, outputLimit: 4096, upperUsd: openRouterBound(providerLimits, 4096).upperUsd, ...(imageInput ? { imageInput } : {}) };
  };
  const body = (image: string | string[], providerLimits: object) => JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: false, store: false,
    max_tokens: 4096, provider: openRouterBound(providerLimits as never, 4096).routing,
    messages: [{ role: 'user', content: [{ type: 'text', text: imageMark(1) + '看图' },
      ...[image].flat().map(one => ({ type: 'image_url', image_url: { url: one } }))] }] });
  const adapter = () => openRouterAdapter({ credential: async () => 'LOCAL_SYNTHETIC_KEY', transport: vi.fn(async () => new Response('{}')) });

  it('sends the images its quote admitted (up to 4), with OpenRouter told the image itself costs nothing', async () => {
    const admitted = identity('0', { maxDataUrlBytes: 819_223, maxEdge: 2048 });
    await expect(adapter().prepareDispatch({ input: body(url(1170, 2048), admitted.providerLimits) }, admitted)).resolves.toBeTypeOf('function');
    await expect(adapter().prepareDispatch({ input: body(Array(4).fill(url(800, 600)), admitted.providerLimits) }, admitted))
      .resolves.toBeTypeOf('function');
    await expect(adapter().prepareDispatch({ input: body(Array(5).fill(url(800, 600)), admitted.providerLimits) }, admitted))
      .rejects.toThrow('REQUEST_DENIED');
    expect(JSON.parse(body(url(10, 10), admitted.providerLimits)).provider.max_price.image).toBe(0);
  });

  it('refuses an image beyond the admitted allowance, and any image on a quote that admitted none', async () => {
    const small = identity('0', { maxDataUrlBytes: 819_223, maxEdge: 1600 });
    await expect(adapter().prepareDispatch({ input: body(url(1170, 2048), small.providerLimits) }, small)).rejects.toThrow('REQUEST_DENIED');
    const none = identity(undefined);
    await expect(adapter().prepareDispatch({ input: body(url(800, 600), none.providerLimits) }, none)).rejects.toThrow('REQUEST_DENIED');
    // An allowance without max_price.image = 0 is not one the quote made.
    const unpriced = { ...identity(undefined), imageInput: { maxDataUrlBytes: 819_223, maxEdge: 2048 } };
    await expect(adapter().prepareDispatch({ input: body(url(800, 600), unpriced.providerLimits) }, unpriced)).rejects.toThrow('REQUEST_DENIED');
  });
});
