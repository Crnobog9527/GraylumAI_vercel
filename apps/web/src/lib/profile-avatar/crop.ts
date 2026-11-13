/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** PROFILE-AVATAR: what the browser accepts before cropping. The server checks the bytes again (JPEG/PNG/WebP, 2 MB). */
export const AVATAR_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** A phone photo can be large; it is shrunk here, so only absurd inputs are refused before decoding. */
export const AVATAR_INPUT_MAX_BYTES = 20 * 1024 * 1024;
export const AVATAR_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 512;

export function avatarInputProblem(file: { type: string; size: number }): string | null {
  if (!(AVATAR_INPUT_TYPES as readonly string[]).includes(file.type)) return '只支持 JPG、PNG 或 WebP 图片';
  if (file.size < 1 || file.size > AVATAR_INPUT_MAX_BYTES) return '图片太大了，请换一张 20MB 以内的图片';
  return null;
}

/** The centred square of an image: the largest square that fits, in source pixels. */
export function centredSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality));

/** Crop to a centred square, scale to at most 512 px and re-encode (which also drops EXIF, such as a GPS position).
 * WebP where the browser can encode it, otherwise JPEG; quality steps down until the file is under 2 MB. */
export async function cropAvatar(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { sx, sy, side } = centredSquare(bitmap.width, bitmap.height);
    if (side < 1) throw new Error('AVATAR_EMPTY');
    const size = Math.min(AVATAR_SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('AVATAR_CANVAS');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    for (const quality of [0.86, 0.7, 0.5]) {
      let blob = await toBlob(canvas, 'image/webp', quality);
      // A browser that cannot encode WebP silently returns PNG: use JPEG instead.
      if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
      if (blob && blob.size <= AVATAR_OUTPUT_MAX_BYTES) return blob;
    }
    throw new Error('AVATAR_TOO_LARGE');
  } finally { bitmap.close(); }
}
