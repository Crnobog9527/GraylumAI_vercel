/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { imageQuote, imageTokensUpper, jpegDimensions, measureImage, JPEG_DATA_URL_PREFIX } from './imageInput';
import { syntheticJpeg } from '../__tests__/fixtures/syntheticJpeg';


const url = (bytes: Buffer) => JPEG_DATA_URL_PREFIX + bytes.toString('base64');
const policy = { maxDataUrlBytes: 819_223, maxEdge: 1600 };
const request = (...parts: unknown[]) => ({ messages: [{ role: 'user', content: [{ type: 'text', text: '识别' }, ...parts] }] });
const image = (u: string) => ({ type: 'image_url', image_url: { url: u } });

describe('jpegDimensions', () => {
  it('reads the frame header without decoding', () => {
    expect(jpegDimensions(syntheticJpeg(1600, 1131))).toEqual({ width: 1600, height: 1131 });
    expect(jpegDimensions(syntheticJpeg(827, 1170, { marker: 0xc2, components: 1 }))).toEqual({ width: 827, height: 1170 });
  });
  it.each([
    ['not a JPEG', Buffer.from('<svg/>')],
    ['no end marker', syntheticJpeg(10, 10, { dropEoi: true })],
    ['scan before frame', syntheticJpeg(10, 10, { scanFirst: true })],
    ['two frames', syntheticJpeg(10, 10, { extraFrame: true })],
    ['lossless frame', syntheticJpeg(10, 10, { marker: 0xc3 })],
    ['12-bit precision', syntheticJpeg(10, 10, { precision: 12 })],
    ['two components', syntheticJpeg(10, 10, { components: 2 })],
    ['zero width', syntheticJpeg(0, 10)],
    ['truncated', syntheticJpeg(10, 10).subarray(0, 12)],
  ])('refuses %s', (_, bytes) => {
    expect(() => jpegDimensions(bytes)).toThrow('BILL2_IMAGE_INVALID');
  });
});

describe('imageTokensUpper', () => {
  it('is twice the 14-pixel patch count plus overhead', () => {
    expect(imageTokensUpper(1600, 1131)).toBe(2 * 115 * 81 + 2048);
    expect(() => imageTokensUpper(63, 200)).toThrow();
    expect(() => imageTokensUpper(2049, 1000)).toThrow();
    expect(() => imageTokensUpper(400, 1601)).toThrow(); // taller than 4:1
    expect(imageTokensUpper(400, 1600)).toBe(2 * 29 * 115 + 2048);
  });
  // Published image-token rules of common vision models; the ceiling must cover all of them.
  const schemes: Array<[string, (w: number, h: number) => number]> = [
    ['750 px² per token', (w, h) => Math.ceil((w * h) / 750)],
    ['512 tiles after 768 short side', (w, h) => {
      const s = Math.min(1, 2048 / Math.max(w, h)), w1 = w * s, h1 = h * s, k = Math.min(1, 768 / Math.min(w1, h1));
      return 85 + 170 * Math.ceil((w1 * k) / 512) * Math.ceil((h1 * k) / 512);
    }],
    ['768 tiles of 258', (w, h) => 258 * Math.max(1, Math.ceil(w / 768) * Math.ceil(h / 768))],
    ['336 tiles of 576 plus thumbnail', (w, h) => 576 * (Math.ceil(w / 336) * Math.ceil(h / 336) + 1)],
    ['28 px patches', (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28)],
    ['32 px patches ×1.62', (w, h) => Math.ceil(1.62 * Math.ceil(w / 32) * Math.ceil(h / 32))],
  ];
  it.each(schemes)('covers %s', (_, tokens) => {
    let worst = 0;
    for (let w = 64; w <= 2048; w += 3)
      for (let h = Math.max(64, Math.ceil(w / 4)); h <= Math.min(2048, 4 * w); h += 5)
        worst = Math.max(worst, tokens(w, h) / imageTokensUpper(w, h));
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('measureImage', () => {
  const jpeg = syntheticJpeg(1600, 1131);
  it('measures the one inline JPEG', () => {
    const quote = measureImage(request(image(url(jpeg))), policy);
    expect(quote).toEqual({ dataUrlBytes: Buffer.byteLength(url(jpeg)), width: 1600, height: 1131, tokensUpper: imageTokensUpper(1600, 1131) });
    expect(imageQuote.safeParse(quote).success).toBe(true);
    expect(imageQuote.safeParse({ ...quote, tokensUpper: quote!.tokensUpper - 1 }).success).toBe(false);
    expect(measureImage({ messages: [{ role: 'user', content: 'text only' }] }, policy)).toBeNull();
  });
  it.each([
    ['no image allowance on the route', request(image(url(jpeg))), undefined],
    ['two images', request(image(url(jpeg)), image(url(jpeg))), policy],
    ['a remote address', request(image('https://example.invalid/page.jpg')), policy],
    ['a PNG data URL', request(image('data:image/png;base64,' + jpeg.toString('base64'))), policy],
    ['a detail flag', request({ ...image(url(jpeg)), image_url: { url: url(jpeg), detail: 'high' } }), policy],
    ['broken base64', request(image(JPEG_DATA_URL_PREFIX + '***')), policy],
    ['an edge above the route maximum', request(image(url(syntheticJpeg(1601, 1000)))), policy],
    ['a sliver image', request(image(url(syntheticJpeg(1000, 40)))), policy],
    ['more bytes than the route allows', request(image(url(jpeg))), { ...policy, maxDataUrlBytes: 32 }],
    ['an SVG renamed to JPEG', request(image(JPEG_DATA_URL_PREFIX + Buffer.from('<svg onload=x>').toString('base64'))), policy],
  ])('refuses %s', (_, parsed, routePolicy) => {
    expect(() => measureImage(parsed, routePolicy)).toThrow(/BILL2_IMAGE_(DENIED|INVALID)/);
  });
});
