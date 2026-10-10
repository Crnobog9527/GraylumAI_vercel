/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { MAX_EMBEDDED_IMAGES, MAX_HEADING_CHARS, MAX_HEADINGS, MAX_IMAGE_BYTES_TOTAL, MAX_WARNINGS, SANDBOX_LIMITS } from '../limits';
import { isRecord } from '../protocol';
import type { DocxExtraction, DocxHeading, DocxImage, DocxWarning } from './document-text';

/**
 * The page's check of what came back from the sandbox. The reply is treated as untrusted: every
 * field is type- and range-checked and copied into a fresh object; anything else is a protocol error.
 */

const WARNINGS = new Set<DocxWarning>(['IMAGE_LIMIT', 'EXTERNAL_IMAGE']);
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,80}$/i;

const reject = (): never => {
  throw new SandboxError('SANDBOX_PROTOCOL');
};
const isIndex = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

function heading(value: unknown, textLength: number): DocxHeading {
  if (!isRecord(value) || !isIndex(value.level, 9) || value.level < 1 || !isIndex(value.offset, textLength)) return reject();
  if (typeof value.text !== 'string' || value.text.length > MAX_HEADING_CHARS) return reject();
  return { level: value.level, text: value.text, offset: value.offset };
}

function image(value: unknown, index: number, textLength: number): DocxImage {
  if (!isRecord(value) || value.index !== index || !isIndex(value.offset, textLength)) return reject();
  if (typeof value.contentType !== 'string' || !CONTENT_TYPE.test(value.contentType)) return reject();
  if (!(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength > MAX_IMAGE_BYTES_TOTAL) return reject();
  return { index, contentType: value.contentType, bytes: value.bytes, offset: value.offset };
}

export function validateDocxExtraction(value: unknown): DocxExtraction {
  if (!isRecord(value) || typeof value.text !== 'string') return reject();
  const text = value.text;
  if (new TextEncoder().encode(text).byteLength > SANDBOX_LIMITS.maxTextBytes) return reject();
  const { headings, images, imageCount, warnings } = value;
  if (!Array.isArray(headings) || headings.length > MAX_HEADINGS) return reject();
  if (!Array.isArray(images) || images.length > MAX_EMBEDDED_IMAGES) return reject();
  if (!isIndex(imageCount, Number.MAX_SAFE_INTEGER) || imageCount < images.length) return reject();
  if (!Array.isArray(warnings) || warnings.length > MAX_WARNINGS) return reject();
  if (!warnings.every((warning) => WARNINGS.has(warning as DocxWarning))) return reject();
  const checkedImages = images.map((item, index) => image(item, index, text.length));
  if (checkedImages.reduce((sum, item) => sum + item.bytes.byteLength, 0) > MAX_IMAGE_BYTES_TOTAL) return reject();
  return {
    text,
    headings: headings.map((item) => heading(item, text.length)),
    images: checkedImages,
    imageCount,
    warnings: [...warnings] as DocxWarning[],
  };
}
