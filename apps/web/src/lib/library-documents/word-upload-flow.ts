/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LIBRARY_MAX_BYTES, WORD_MIME, type LibraryPurpose } from './format';
import { runExtractedUpload, type ExtractedUploadApi } from './extracted-upload-flow';
import type { UploadAttempt, UploadStage } from './upload-flow';

/** Headings as the server checks them (#796): UTF-16 offsets into exactly the uploaded text. */
export type WordHeading = { offset: number; level: number; text: string };
/** What the browser extracted (LIB-2b), ready to upload. Kept on the item so a retry does not re-extract. */
export type PreparedWord = { text: Blob; headings: WordHeading[] };

/** Word two-object upload (#796); completeWordUpload takes the headings. */
export type WordUploadApi = ExtractedUploadApi<{ headings: WordHeading[] }>;

type Input = {
  file: Blob; filename: string; purpose: LibraryPurpose; prepared: PreparedWord;
  attempt: UploadAttempt; newId: () => string; onStage: (stage: UploadStage, progress?: number) => void;
};

const HEADING_MAX_BYTES = 512;
const HEADING_MAX_COUNT = 10_000;
const encoder = new TextEncoder();

/**
 * Converts the LIB-2b result into the upload payload. Headings the server cannot store (over 512 bytes,
 * or past 10,000) are left out of the directory; their words stay in the body, nothing is cut.
 */
export function prepareWord(
  extraction: { text: string; headings: WordHeading[] },
): { ok: true; prepared: PreparedWord } | { ok: false; message: string } {
  if (!extraction.text.trim()) return { ok: false, message: '这个 Word 文件里没有可以读取的文字。' };
  const bytes = encoder.encode(extraction.text);
  if (bytes.length > LIBRARY_MAX_BYTES) return { ok: false, message: '文字内容太多，超出了可以处理的上限，请拆分后再上传。' };
  const headings = extraction.headings
    .filter((heading) => encoder.encode(heading.text).length <= HEADING_MAX_BYTES)
    .slice(0, HEADING_MAX_COUNT)
    .map(({ offset, level, text }) => ({ offset, level, text }));
  return { ok: true, prepared: { text: new Blob([bytes], { type: 'text/plain' }), headings } };
}

export function runWordUpload(api: WordUploadApi, { prepared, ...input }: Input): Promise<{ documentId: string }> {
  return runExtractedUpload(api, { ...input, contentType: WORD_MIME, text: prepared.text, meta: { headings: prepared.headings } });
}
