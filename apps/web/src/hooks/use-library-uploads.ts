/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  checkLibraryFile, libraryErrorCode, libraryErrorMessage, type LibraryPurpose, type UploadContentType,
} from '@/lib/library-documents/format';
import {
  putSignedUpload, runLibraryUpload, UploadFailure, type UploadApi, type UploadAttempt,
} from '@/lib/library-documents/upload-flow';

export type UploadItem = {
  key: string; filename: string; purpose: LibraryPurpose;
  status: 'waiting' | 'begin' | 'transfer' | 'complete' | 'failed' | 'rejected' | 'done';
  progress: number; message?: string;
  file?: File; contentType?: UploadContentType; attempt?: UploadAttempt;
};

/** Sequential upload queue (the server allows at most 4 unfinished uploads per user). */
export function useLibraryUploads(onSettled: () => void, onDisabled: () => void) {
  const begin = trpc.library.beginUpload.useMutation();
  const complete = trpc.library.completeUpload.useMutation();
  const abandon = trpc.library.abandonUpload.useMutation();
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<UploadItem[]>([]);
  const running = useRef(false);
  const update = useCallback((key: string, patch: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const api: UploadApi = {
    begin: (input) => begin.mutateAsync(input),
    complete: (input) => complete.mutateAsync(input),
    abandon: (input) => abandon.mutateAsync(input),
    put: putSignedUpload,
  };
  const apiRef = useRef(api);
  apiRef.current = api;

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!;
        if (!item.file || !item.contentType || !item.attempt) continue;
        try {
          await runLibraryUpload(apiRef.current, {
            file: item.file, filename: item.filename, contentType: item.contentType, purpose: item.purpose,
            attempt: item.attempt, newId: () => crypto.randomUUID(),
            onStage: (stage, progress) => update(item.key, { status: stage, progress: progress ?? 0 }),
          });
          update(item.key, { status: 'done', progress: 1, file: undefined, message: undefined });
        } catch (error) {
          const cause = error instanceof UploadFailure ? error.cause : error;
          const retry = error instanceof UploadFailure ? error.retry : { requestId: crypto.randomUUID(), resume: 'begin' as const };
          if (libraryErrorCode(cause) === 'LIBRARY_DISABLED') onDisabled();
          update(item.key, { status: 'failed', message: libraryErrorMessage(cause), attempt: retry });
        }
        onSettled();
      }
    } finally {
      running.current = false;
    }
  }, [onDisabled, onSettled, update]);

  const add = useCallback((files: File[], purpose: LibraryPurpose) => {
    const added: UploadItem[] = files.map((file) => {
      const key = crypto.randomUUID();
      const check = checkLibraryFile(file);
      if (!check.ok) return { key, filename: file.name, purpose, status: 'rejected', progress: 0, message: check.message };
      return {
        key, filename: file.name, purpose, status: 'waiting', progress: 0, file, contentType: check.contentType,
        attempt: { requestId: crypto.randomUUID(), resume: 'begin' },
      };
    });
    setItems((current) => [...added, ...current.filter((item) => item.status !== 'done')]);
    queue.current.push(...added.filter((item) => item.status === 'waiting'));
    void drain();
  }, [drain]);

  const retry = useCallback((key: string) => {
    const item = items.find((entry) => entry.key === key);
    if (!item || item.status !== 'failed' || !item.file) return;
    const next = { ...item, status: 'waiting' as const, progress: 0, message: undefined };
    update(key, next);
    queue.current.push(next);
    void drain();
  }, [drain, items, update]);

  const dismiss = useCallback((key: string) => {
    setItems((current) => current.filter((item) => item.key !== key || !['failed', 'rejected', 'done'].includes(item.status)));
  }, []);

  const busy = items.some((item) => ['waiting', 'begin', 'transfer', 'complete'].includes(item.status));
  return { items, add, retry, dismiss, busy };
}
