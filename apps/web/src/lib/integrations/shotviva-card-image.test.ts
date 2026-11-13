/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CARD_IMAGE_WIDTH, cardImage } from './shotviva-card-image';

// Shotviva returns a 1536 px PNG; noise keeps it large, like a photo (about 7 MB here).
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: '#a87b54',
  noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).png().toBuffer();

describe('cardImage', () => {
  it('a large PNG becomes a WebP twice the card width, much smaller', async () => {
    const input = await png(1536, 1536);
    const card = await cardImage(input, 'image/png');
    expect(card.contentType).toBe('image/webp');
    const meta = await sharp(card.bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(CARD_IMAGE_WIDTH);
    expect(meta.height).toBe(CARD_IMAGE_WIDTH);
    expect(card.bytes.byteLength).toBeLessThan(input.byteLength / 4);
  });

  it('a small image is not enlarged; one that would not get smaller, or that sharp cannot read, is sent as it came', async () => {
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#fff' } }).webp().toBuffer();
    const kept = await cardImage(small, 'image/webp');
    expect((await sharp(kept.bytes).metadata()).width).toBeLessThanOrEqual(300);
    const broken = new Uint8Array([1, 2, 3]);
    expect(await cardImage(broken, 'image/png')).toEqual({ bytes: broken, contentType: 'image/png' });
  });
});
