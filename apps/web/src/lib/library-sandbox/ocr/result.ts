/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isSandboxErrorCode, SandboxError } from '../errors';
import { OCR_LIMITS } from '../limits';
import { isRecord } from '../protocol';
import type { OcrBatch, OcrPage } from './types';

/** The Worker's reply is untrusted data: exactly one well-formed result per image, or the batch is refused. */
export function validateOcrBatch(value: unknown, images: number): OcrBatch {
  const reject = (): never => { throw new SandboxError('SANDBOX_PROTOCOL'); };
  if (!isRecord(value) || !Array.isArray(value.pages) || value.pages.length !== images) return reject();
  const pages = value.pages.map((page): OcrPage => {
    if (!isRecord(page)) return reject();
    if (page.ok === false) return isSandboxErrorCode(page.code) ? { ok: false, code: page.code } : reject();
    const { text, confidence, angle, flipped, ms } = page;
    if (page.ok !== true || typeof text !== 'string' || text.length > OCR_LIMITS.maxPageChars
      || typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)
      || typeof angle !== 'number' || !(Math.abs(angle) <= 6) || typeof flipped !== 'boolean'
      || typeof ms !== 'number' || !(ms >= 0)) return reject();
    return { ok: true, text, confidence, angle, flipped, ms };
  });
  return { pages };
}
