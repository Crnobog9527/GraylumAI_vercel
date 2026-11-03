/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { chatImage, IMAGE_MARK, withImage } from './chatImage';
import { JPEG_DATA_URL_PREFIX } from './provider/imageInput';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterBound } from './provider/openRouterPolicy';
import { syntheticJpeg } from '../__tests__/fixtures/syntheticJpeg';

const url = (width: number, height: number, filler = 0) => JPEG_DATA_URL_PREFIX
  + Buffer.concat([syntheticJpeg(width, height).subarray(0, -2), Buffer.alloc(filler, 7), Buffer.from([0xff, 0xd9])]).toString('base64');

describe('a chat image', () => {
  it('is one JPEG within LIB-2d limits: 614,400 bytes and 2048 px a side', () => {
    expect(chatImage(url(1170, 2048))).toMatchObject({ width: 1170, height: 2048, url: url(1170, 2048) });
    expect(chatImage(url(2049, 1000))).toBeNull();
    expect(chatImage(url(1000, 1000, 614_400))).toBeNull();
    expect(chatImage('data:image/png;base64,' + Buffer.from('png').toString('base64'))).toBeNull();
    expect(chatImage(JPEG_DATA_URL_PREFIX + 'not base64')).toBeNull();
    expect(chatImage('https://example.com/a.jpg')).toBeNull();
  });

  it('joins only the current (last) user message, after its text', () => {
    const history = { type: 'message', role: 'user', content: 'earlier' }, current = { type: 'message', role: 'user', content: IMAGE_MARK + '看图' };
    expect(withImage([history, current], 'data:x')).toEqual([history,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: IMAGE_MARK + '看图' }, { type: 'input_image', image: 'data:x' }] }]);
  });
});

describe('the OpenRouter adapter and a turn-core chat image', () => {
  const limits = { providerSlug: 'anthropic', contextTokens: 200_000, promptUsdPerMillion: '3', completionUsdPerMillion: '15', requestUsd: '0' };
  const identity = (imageUsd: string | undefined, imageInput?: { maxDataUrlBytes: number; maxEdge: number }) => {
    const providerLimits = { ...limits, ...(imageUsd === undefined ? {} : { imageUsd }) };
    return { provider: 'openrouter', account: 'test', model: 'anthropic/claude-sonnet-5.5', protocol: 'openrouter-chat-v1' as const,
      providerLimits, outputLimit: 4096, upperUsd: openRouterBound(providerLimits, 4096).upperUsd, ...(imageInput ? { imageInput } : {}) };
  };
  const body = (image: string, providerLimits: object) => JSON.stringify({ model: 'anthropic/claude-sonnet-5.5', stream: false, store: false,
    max_tokens: 4096, provider: openRouterBound(providerLimits as never, 4096).routing,
    messages: [{ role: 'user', content: [{ type: 'text', text: IMAGE_MARK + '看图' }, { type: 'image_url', image_url: { url: image } }] }] });
  const adapter = () => openRouterAdapter({ credential: async () => 'LOCAL_SYNTHETIC_KEY', transport: vi.fn(async () => new Response('{}')) });

  it('sends the one image its quote admitted, with OpenRouter told the image itself costs nothing', async () => {
    const admitted = identity('0', { maxDataUrlBytes: 819_223, maxEdge: 2048 });
    await expect(adapter().prepareDispatch({ input: body(url(1170, 2048), admitted.providerLimits) }, admitted)).resolves.toBeTypeOf('function');
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
