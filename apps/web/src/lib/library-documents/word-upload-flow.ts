/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LIBRARY_MAX_BYTES, WORD_MIME, type LibraryPurpose } from './format';
import { runExtractedUpload, type ExtractedUploadApi } from './extracted-upload-flow';
import { isLibraryScanRecognitionEnabled } from '@/lib/library-sandbox/feature-flag';
import type { UploadAttempt, UploadStage } from './upload-flow';

/** Headings as the server checks them (#796): UTF-16 offsets into exactly the uploaded text. */
export type WordHeading = { offset: number; level: number; text: string };
/** UTF-16 offsets of the embedded images in the uploaded text (LIB-2d, 0287): one recognition unit each. */
export type WordImage = { offset: number };
/** What the browser extracted (LIB-2b), ready to upload. Kept on the item so a retry does not re-extract. */
export type PreparedWord = { text: Blob; headings: WordHeading[]; images?: WordImage[] };

/** Word two-object upload (#796); completeWordUpload takes the headings and, with recognition on, the image offsets. */
export type WordUploadApi = ExtractedUploadApi<{ headings: WordHeading[]; images?: WordImage[] }>;

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
  extraction: { text: string; headings: WordHeading[]; images?: Array<{ offset: number }> },
): { ok: true; prepared: PreparedWord } | { ok: false; message: string } {
  const recognise = isLibraryScanRecognitionEnabled() && !!extraction.images?.length;
  // A Word file that is only images (a typical scanned Word) uploads empty text; its images are recognised later.
  const imagesOnly = !extraction.text.trim();
  if (imagesOnly && !recognise) return { ok: false, message: '这个 Word 文件里没有可以读取的文字。' };
  const bytes = encoder.encode(imagesOnly ? '' : extraction.text);
  if (bytes.length > LIBRARY_MAX_BYTES) return { ok: false, message: '文字内容太多，超出了可以处理的上限，请拆分后再上传。' };
  const headings = imagesOnly ? [] : extraction.headings
    .filter((heading) => encoder.encode(heading.text).length <= HEADING_MAX_BYTES)
    .slice(0, HEADING_MAX_COUNT)
    .map(({ offset, level, text }) => ({ offset, level, text }));
  // Images become recognition units only when browser recognition is built in (the server switch decides the rest).
  const images = recognise ? extraction.images!.map(({ offset }) => ({ offset: imagesOnly ? 0 : offset })) : undefined;
  return { ok: true, prepared: { text: new Blob([bytes], { type: 'text/plain' }), headings, ...(images ? { images } : {}) } };
}

export function runWordUpload(api: WordUploadApi, { prepared, ...input }: Input): Promise<{ documentId: string }> {
  const meta = { headings: prepared.headings, ...(prepared.images ? { images: prepared.images } : {}) };
  return runExtractedUpload(api, { ...input, contentType: WORD_MIME, text: prepared.text, meta });
}
