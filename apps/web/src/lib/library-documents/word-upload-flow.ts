/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { LIBRARY_MAX_BYTES, libraryErrorCode, WORD_MIME, type LibraryPurpose, type UploadContentType } from './format';
import {
  release, releasePending, UploadFailure, type BeginResult, type UploadAttempt, type UploadStage,
} from './upload-flow';

/** Headings as the server checks them (#796): UTF-16 offsets into exactly the uploaded text. */
export type WordHeading = { offset: number; level: number; text: string };
/** What the browser extracted (LIB-2b), ready to upload. Kept on the item so a retry does not re-extract. */
export type PreparedWord = { text: Blob; headings: WordHeading[] };

/**
 * Word two-object upload (#796): beginWordUpload → PUT original → beginWordTextUpload → PUT UTF-8 text →
 * completeWordUpload with headings. Each grant is issued once; a repeat returns upload=null.
 */
export type WordUploadApi = {
  begin(input: {
    requestId: string; filename: string; contentType: typeof WORD_MIME; bytes: number; purpose: LibraryPurpose;
  }): Promise<BeginResult>;
  beginText(input: { documentId: string }): Promise<BeginResult>;
  complete(input: { documentId: string; headings: WordHeading[] }): Promise<unknown>;
  abandon(input: { documentId: string }): Promise<unknown>;
  put(url: string, file: Blob, contentType: UploadContentType, onProgress: (fraction: number) => void): Promise<void>;
};

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

export async function runWordUpload(api: WordUploadApi, input: Input): Promise<{ documentId: string }> {
  const { newId, onStage } = input;
  if (input.attempt.releaseFirst) onStage('begin');
  const attempt = await releasePending(api, input.attempt);
  const restart = () => runWordUpload(api, { ...input, attempt: { requestId: newId(), resume: 'begin' } });
  // Any definite rejection after begin: release the row (idempotent), then the retry starts over.
  const reject = async (documentId: string, error: unknown): Promise<never> => {
    await release(api, documentId, error, newId);
    throw new UploadFailure(error, { requestId: newId(), resume: 'begin' });
  };

  const complete = async (documentId: string) => {
    onStage('complete');
    try {
      await api.complete({ documentId, headings: input.prepared.headings });
    } catch (error) {
      if (!libraryErrorCode(error)) throw new UploadFailure(error, { requestId: attempt.requestId, documentId, resume: 'complete' });
      return reject(documentId, error);
    }
    return { documentId };
  };

  const sendText = async (documentId: string) => {
    onStage('transfer', 0.5);
    let grant: BeginResult;
    try {
      grant = await api.beginText({ documentId });
    } catch (error) {
      if (!libraryErrorCode(error)) throw new UploadFailure(error, { requestId: attempt.requestId, documentId, resume: 'text' });
      return reject(documentId, error);
    }
    if (grant.status === 'ready') return { documentId };
    if (!grant.upload) {
      // The text link went to an earlier attempt and cannot be re-sent: release this row and start again.
      await release(api, documentId, new Error('LIBRARY_UPLOAD_UNAVAILABLE'), newId);
      return restart();
    }
    try {
      await api.put(grant.upload.signedUrl, input.prepared.text, 'text/plain', (fraction) => onStage('transfer', 0.5 + fraction / 2));
    } catch (error) {
      return reject(documentId, error);
    }
    return complete(documentId);
  };

  if (attempt.resume === 'complete' && attempt.documentId) return complete(attempt.documentId);
  if (attempt.resume === 'text' && attempt.documentId) return sendText(attempt.documentId);

  onStage('begin');
  let grant: BeginResult;
  try {
    grant = await api.begin({
      requestId: attempt.requestId, filename: input.filename, contentType: WORD_MIME,
      bytes: input.file.size, purpose: input.purpose,
    });
  } catch (error) {
    const retry = libraryErrorCode(error) ? { requestId: newId(), resume: 'begin' as const } : attempt;
    throw new UploadFailure(error, retry);
  }
  if (grant.status === 'ready') return { documentId: grant.documentId };
  if (!grant.upload) {
    await release(api, grant.documentId, new Error('LIBRARY_UPLOAD_UNAVAILABLE'), newId);
    return restart();
  }
  onStage('transfer', 0);
  try {
    await api.put(grant.upload.signedUrl, input.file, WORD_MIME, (fraction) => onStage('transfer', fraction / 2));
  } catch (error) {
    return reject(grant.documentId, error);
  }
  return sendText(grant.documentId);
}
