/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SandboxErrorCode } from '../errors';

/** One recognised image: its text in reading order, or the stable reason it could not be read. */
export type OcrPage =
  | { ok: true; text: string; confidence: number; angle: number; flipped: boolean; ms: number }
  | { ok: false; code: SandboxErrorCode };

export type OcrBatch = { pages: OcrPage[] };
