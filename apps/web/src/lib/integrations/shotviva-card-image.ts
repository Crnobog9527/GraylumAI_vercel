/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import sharp from 'sharp';
import { logger } from '@repo/api/src/lib/logger';

/*
 * INTEGRATION-SHOTVIVA: the card under a reply is at most 420 px wide (image-step-cards.module.css), so the image it shows is twice that,
 * as WebP. Shotviva's partner API has no thumbnail or format option; its PNG (about 1.5 to 3.5 MB at 1536 px) took about 10 seconds to
 * show in the chat. The full image stays on Shotviva ("在 Shotviva 查看").
 */
export const CARD_IMAGE_WIDTH = 840;
const WEBP_QUALITY = 80;
/** sharp's own guard against a decompression bomb, set well above the 1536 x 1536 Shotviva returns. */
const MAX_INPUT_PIXELS = 40_000_000;

/** The card's image: at most CARD_IMAGE_WIDTH wide, WebP. An image sharp cannot read, or one that would not get smaller, is sent as it
 * came (already checked as a JPEG, PNG or WebP of at most 20 MB), so the card still shows it. */
export async function cardImage(bytes: Uint8Array, contentType: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  try {
    const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      .resize({ width: CARD_IMAGE_WIDTH, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toBuffer();
    return out.byteLength < bytes.byteLength ? { bytes: out, contentType: 'image/webp' } : { bytes, contentType };
  } catch {
    logger.warn('system', 'shotviva_card_image_resize_failed', {});
    return { bytes, contentType };
  }
}
