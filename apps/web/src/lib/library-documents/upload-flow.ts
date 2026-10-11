/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isSignedStorageUrl } from './signed-url';
import { libraryErrorCode, type LibraryPurpose, type UploadContentType, type WORD_MIME } from './format';

/** Single-object uploads; Word goes through word-upload-flow. */
export type PlainContentType = Exclude<UploadContentType, typeof WORD_MIME>;

/**
 * One library upload (LIB-2a contract, #778): begin → direct PUT to the private bucket → complete.
 * Begin is idempotent by requestId and never re-issues a link (upload=null on repeat). The server
 * removes the document itself when complete fails with a LIBRARY_* code.
 */
export type BeginResult = { documentId: string; status: string; upload: { signedUrl: string } | null };
export type UploadApi = {
  begin(input: {
    requestId: string; filename: string; contentType: PlainContentType; bytes: number; purpose: LibraryPurpose;
  }): Promise<BeginResult>;
  complete(input: { documentId: string }): Promise<unknown>;
  abandon(input: { documentId: string }): Promise<unknown>;
  put(url: string, file: Blob, contentType: UploadContentType, onProgress: (fraction: number) => void): Promise<void>;
};

export type UploadStage = 'begin' | 'transfer' | 'complete';
/**
 * Where a retry should resume. `complete` only after an unknown (network) result of complete;
 * `text` (Word only) after an unknown result of the second-stage grant, once the original is stored.
 * `releaseFirst`: an earlier row whose release was not confirmed; it is released before any new request,
 * so failed releases never stack up 10 MB reservations or unfinished-upload slots.
 */
export type UploadAttempt = {
  requestId: string; documentId?: string; resume: 'begin' | 'text' | 'complete'; releaseFirst?: string;
};
export class UploadFailure extends Error {
  constructor(readonly cause: unknown, readonly retry: UploadAttempt) {
    super('LIBRARY_UPLOAD_FAILED');
  }
}

type Input = {
  file: Blob; filename: string; contentType: PlainContentType; purpose: LibraryPurpose;
  attempt: UploadAttempt; newId: () => string; onStage: (stage: UploadStage, progress?: number) => void;
};

type Abandon = Pick<UploadApi, 'abandon'>;
/**
 * Releases an unfinished row (abandon is idempotent: an already removed row reports `deleted`).
 * If the release is not confirmed, the retry releases it first. Never call it for a row that may be ready.
 */
export async function release(api: Abandon, documentId: string, cause: unknown, newId: () => string) {
  try {
    await api.abandon({ documentId });
  } catch {
    throw new UploadFailure(cause, { requestId: newId(), resume: 'begin', releaseFirst: documentId });
  }
}

/** A retry that still owes a release does it before anything else; the attempt then starts fresh. */
export async function releasePending(api: Abandon, attempt: UploadAttempt): Promise<UploadAttempt> {
  if (!attempt.releaseFirst) return attempt;
  try {
    await api.abandon({ documentId: attempt.releaseFirst });
  } catch (error) {
    throw new UploadFailure(error, attempt);
  }
  return { requestId: attempt.requestId, resume: 'begin' };
}

/**
 * Before a failed item leaves the page, settle the server row it may still hold, so removing it never
 * drops recovery work: a pending release is done now; a Word row waiting for its text is released;
 * an unknown completion is re-checked (it may already be ready, so it is never released blindly).
 * Throws when the outcome is still unknown; the caller keeps the item so the user can try again.
 */
export async function settleFailedAttempt(
  api: Abandon, attempt: UploadAttempt | undefined, recheck: (documentId: string) => Promise<unknown>,
): Promise<void> {
  if (!attempt) return;
  if (attempt.releaseFirst) await api.abandon({ documentId: attempt.releaseFirst });
  if (!attempt.documentId) return;
  if (attempt.resume === 'text') {
    await api.abandon({ documentId: attempt.documentId });
    return;
  }
  if (attempt.resume !== 'complete') return;
  try {
    await recheck(attempt.documentId);
  } catch (error) {
    if (!libraryErrorCode(error)) throw error;
    // A definite rejection means it is not ready; make sure nothing is left holding space.
    await api.abandon({ documentId: attempt.documentId });
  }
}

export async function runLibraryUpload(api: UploadApi, input: Input): Promise<{ documentId: string }> {
  const { file, newId, onStage } = input;
  if (input.attempt.releaseFirst) onStage('begin');
  const attempt = await releasePending(api, input.attempt);
  if (attempt.resume === 'complete' && attempt.documentId) {
    onStage('complete');
    try {
      await api.complete({ documentId: attempt.documentId });
      return { documentId: attempt.documentId };
    } catch (error) {
      const code = libraryErrorCode(error);
      if (!code) throw new UploadFailure(error, attempt);
      // Definite rejection: the server already removed it. Start over with a new request.
      if (code !== 'LIBRARY_NOT_FOUND') throw new UploadFailure(error, { requestId: newId(), resume: 'begin' });
      return runLibraryUpload(api, { ...input, attempt: { requestId: newId(), resume: 'begin' } });
    }
  }
  onStage('begin');
  let grant: BeginResult;
  try {
    grant = await api.begin({
      requestId: attempt.requestId, filename: input.filename, contentType: input.contentType,
      bytes: file.size, purpose: input.purpose,
    });
  } catch (error) {
    // Unknown result keeps the same requestId, so a retry reuses the same server row.
    const retry = libraryErrorCode(error) ? { requestId: newId(), resume: 'begin' as const } : attempt;
    throw new UploadFailure(error, retry);
  }
  if (grant.status === 'ready') return { documentId: grant.documentId };
  if (!grant.upload) {
    // An earlier attempt got the link; it cannot be re-sent. Release that row and start again.
    await release(api, grant.documentId, new Error('LIBRARY_UPLOAD_UNAVAILABLE'), newId);
    return runLibraryUpload(api, { ...input, attempt: { requestId: newId(), resume: 'begin' } });
  }
  onStage('transfer', 0);
  try {
    await api.put(grant.upload.signedUrl, file, input.contentType, (fraction) => onStage('transfer', fraction));
  } catch (error) {
    await release(api, grant.documentId, error, newId);
    throw new UploadFailure(error, { requestId: newId(), resume: 'begin' });
  }
  onStage('complete');
  try {
    await api.complete({ documentId: grant.documentId });
  } catch (error) {
    const retry: UploadAttempt = libraryErrorCode(error)
      ? { requestId: newId(), resume: 'begin' }
      : { requestId: attempt.requestId, documentId: grant.documentId, resume: 'complete' };
    throw new UploadFailure(error, retry);
  }
  return { documentId: grant.documentId };
}

/** Direct PUT to the storage signed-upload URL, with progress. The body is the file itself. */
export function putSignedUpload(
  url: string, file: Blob, contentType: UploadContentType, onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!isSignedStorageUrl(url, 'upload')) {
      reject(new Error('LIBRARY_STORAGE_UNAVAILABLE'));
      return;
    }
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('content-type', contentType);
    request.setRequestHeader('x-upsert', 'false');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : reject(new Error('UPLOAD_HTTP')));
    request.onerror = () => reject(new Error('UPLOAD_NETWORK'));
    request.onabort = () => reject(new Error('UPLOAD_ABORTED'));
    request.timeout = 10 * 60_000;
    request.ontimeout = () => reject(new Error('UPLOAD_TIMEOUT'));
    request.send(file);
  });
}
