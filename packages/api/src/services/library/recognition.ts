/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { checkRateLimitAsync } from '../../middleware/securityChecks';
import { libraryRpc } from './rpc';

/**
 * LIB-2d: saving text that the user's own browser recognised from a scanned PDF page or a Word image (Owner
 * 2026-10-17: browser PaddleOCR, no model call, no charge). The server never sees the image; it stores the text as
 * that unit's segments under the actor and document locks (quota, content version, one save per unit). Off unless
 * the `library_scan_recognition_enabled` setting is true (migration 0287).
 */

/** Recognised text of one page: plain text, at most 100,000 characters (the browser engine's per-page cap). */
export const MAX_RECOGNIZED_CHARS = 100_000;
const position = z.number().int().min(1).max(500);
const documentId = z.string().uuid();
export const recognitionKind = z.enum(['pdf_page', 'word_image']);
const kind = recognitionKind;
export const recognitionSaveInput = z.object({
  documentId, kind, position, version: z.number().int().positive(), text: z.string().min(1).max(MAX_RECOGNIZED_CHARS),
}).strict();
export const recognitionFailInput = z.object({ documentId, kind, position }).strict();

export type RecognitionStatus = 'pending' | 'running' | 'complete' | 'paused' | 'over_limit' | 'settling' | 'failed';
/** `positions` are PDF page numbers (format pdf) or Word image numbers in document order (format docx). */
export type RecognitionPending = Array<{ documentId: string; format: 'pdf' | 'docx'; contentVersion: number; positions: number[] }>;
export type RecognitionSave = { saved: boolean; status: RecognitionStatus; contentVersion: number; code?: 'LIBRARY_SPACE' | 'LIBRARY_TEXT_LIMIT' };

const SEGMENT_MAX_BYTES = 8192;

/**
 * Recognised text as segments of at most 8,192 bytes, titled with the page or image number. A segment ends at a
 * blank line only once it holds half of that, so a page of many short paragraphs stays far under the database's
 * 200 segments per unit (100,000 characters are at most about 100 segments). The text itself is unchanged.
 */
export function recognizedSegments(text: string, unit: z.infer<typeof recognitionKind>, page: number) {
  if (!text.isWellFormed() || /[\x00-\x08\x0b-\x1f\x7f\u2028\u2029]/.test(text)) throw new Error('LIBRARY_TYPE');
  if (!/\S/u.test(text)) throw new Error('LIBRARY_INVALID');
  const title = unit === 'pdf_page' ? `第 ${page} 页` : `图片 ${page}（识别）`;
  const segments: Array<{ title: string; body: string }> = [];
  let body = '';
  let size = 0;
  const flush = () => {
    if (body) segments.push({ title, body });
    body = ''; size = 0;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (Buffer.byteLength(line) > 65_536) throw new Error('LIBRARY_LINE_LIMIT');
    if (!line.trim() && size >= SEGMENT_MAX_BYTES / 2) flush();
    for (const char of line) {
      const width = Buffer.byteLength(char);
      if (size + width > SEGMENT_MAX_BYTES) flush();
      body += char; size += width;
    }
  }
  flush();
  return segments;
}

export function libraryRecognition(client: SupabaseClient, actorId: string) {
  return {
    /** Ready PDFs that still have pages waiting (at most 20 documents, 50 pages each); empty when the switch is off. */
    recognitionPending() {
      return libraryRpc<RecognitionPending>(client, 'library_recognition_pending', { a: actorId });
    },
    async saveRecognized(raw: z.infer<typeof recognitionSaveInput>) {
      const input = recognitionSaveInput.parse(raw);
      await checkRateLimitAsync(actorId, 'api');
      let segments;
      try {
        segments = recognizedSegments(input.text, input.kind, input.position);
      } catch (error) {
        const message = error instanceof Error && /^LIBRARY_[A-Z_]+$/.test(error.message) ? error.message : 'LIBRARY_INVALID';
        throw new TRPCError({ code: 'BAD_REQUEST', message });
      }
      return libraryRpc<RecognitionSave>(client, 'library_recognition_save', {
        a: actorId, did: input.documentId, kind: input.kind, pos: input.position, ver: input.version, segments,
      });
    },
    async failRecognized(raw: z.infer<typeof recognitionFailInput>) {
      const input = recognitionFailInput.parse(raw);
      await checkRateLimitAsync(actorId, 'api');
      return libraryRpc<{ status: RecognitionStatus }>(client, 'library_recognition_fail', {
        a: actorId, did: input.documentId, kind: input.kind, pos: input.position,
      });
    },
  };
}
