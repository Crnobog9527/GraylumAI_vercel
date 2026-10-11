/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { libraryErrorCode, type ExtractedContentType, type LibraryPurpose, type UploadContentType } from './format';
import {
  release, releasePending, UploadFailure, type BeginResult, type UploadAttempt, type UploadStage,
} from './upload-flow';

/**
 * Two-object upload shared by Word (#796) and PDF (#800): begin → PUT original → beginText → PUT UTF-8
 * text → complete with the format's metadata (Word headings, PDF pages). Each grant is issued once;
 * a repeat returns upload=null.
 */
export type ExtractedUploadApi<Meta> = {
  begin(input: {
    requestId: string; filename: string; contentType: ExtractedContentType; bytes: number; purpose: LibraryPurpose;
  }): Promise<BeginResult>;
  beginText(input: { documentId: string }): Promise<BeginResult>;
  complete(input: { documentId: string } & Meta): Promise<unknown>;
  abandon(input: { documentId: string }): Promise<unknown>;
  put(url: string, file: Blob, contentType: UploadContentType, onProgress: (fraction: number) => void): Promise<void>;
};

export type ExtractedUploadInput<Meta> = {
  file: Blob; filename: string; purpose: LibraryPurpose; contentType: ExtractedContentType;
  /** The browser-extracted text, already UTF-8 encoded, and what complete needs besides the id. */
  text: Blob; meta: Meta;
  attempt: UploadAttempt; newId: () => string; onStage: (stage: UploadStage, progress?: number) => void;
};

export async function runExtractedUpload<Meta>(
  api: ExtractedUploadApi<Meta>, input: ExtractedUploadInput<Meta>,
): Promise<{ documentId: string }> {
  const { newId, onStage } = input;
  if (input.attempt.releaseFirst) onStage('begin');
  const attempt = await releasePending(api, input.attempt);
  const restart = () => runExtractedUpload(api, { ...input, attempt: { requestId: newId(), resume: 'begin' } });
  // Any definite rejection after begin: release the row (idempotent), then the retry starts over.
  const reject = async (documentId: string, error: unknown): Promise<never> => {
    await release(api, documentId, error, newId);
    throw new UploadFailure(error, { requestId: newId(), resume: 'begin' });
  };

  const complete = async (documentId: string) => {
    onStage('complete');
    try {
      await api.complete({ documentId, ...input.meta });
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
      await api.put(grant.upload.signedUrl, input.text, 'text/plain', (fraction) => onStage('transfer', 0.5 + fraction / 2));
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
      requestId: attempt.requestId, filename: input.filename, contentType: input.contentType,
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
    await api.put(grant.upload.signedUrl, input.file, input.contentType, (fraction) => onStage('transfer', fraction / 2));
  } catch (error) {
    return reject(grant.documentId, error);
  }
  return sendText(grant.documentId);
}
