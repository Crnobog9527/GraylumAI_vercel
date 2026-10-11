/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useMemo, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';
import { trpc } from '@/trpc/client';
import { libraryErrorMessage, type LibraryPurpose } from '@/lib/library-documents/format';

type ListOutput = inferRouterOutputs<AppRouter>['library']['list'];
export type LibraryDocument = ListOutput['documents'][number];
type Cursor = NonNullable<ListOutput['nextCursor']>;

/**
 * The upload switch (system setting `library_upload_enabled`) is reported by the list response as
 * `uploadEnabled`. Until the server reports `true`, the page shows no upload entry (fail closed).
 */
export function readUploadEnabled(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { uploadEnabled?: unknown }).uploadEnabled === true;
}

/**
 * Pages come in the server's order (upload time, then id, newest first) and are shown in that order;
 * the page never re-sorts, so "load more" only appends older files. A new file appears on reload.
 */
export function mergePages(pages: Array<{ documents: LibraryDocument[] }>): LibraryDocument[] {
  const seen = new Set<string>();
  return pages.flatMap((page) => page.documents).filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}

export function useLibraryDocuments() {
  const [more, setMore] = useState<Array<{ documents: LibraryDocument[]; nextCursor: Cursor | null }>>([]);
  // While older pages are shown, a background refetch of page one could move rows across the page edge,
  // so focus refetch is off then; every change on this page reloads from the first page instead.
  const list = trpc.library.list.useQuery({}, { refetchOnMount: 'always', refetchOnWindowFocus: !more.length });
  const utils = trpc.useUtils();
  const [moreState, setMoreState] = useState<{ loading: boolean; error: string }>({ loading: false, error: '' });
  const [disabledByServer, setDisabledByServer] = useState(false);
  const remove = trpc.library.delete.useMutation();
  const setPurpose = trpc.library.setPurpose.useMutation();
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());
  const [purposes, setPurposes] = useState<Record<string, LibraryPurpose>>({});

  const { refetch } = list;
  const reload = useCallback(async () => {
    setMore([]);
    setPurposes({});
    setMoreState({ loading: false, error: '' });
    await refetch();
  }, [refetch]);

  const markDisabled = useCallback(() => setDisabledByServer(true), []);
  const raw = useMemo(() => (list.data ? mergePages([list.data, ...more]) : []), [list.data, more]);
  const cursor = (more.length ? more.at(-1)!.nextCursor : list.data?.nextCursor) ?? null;

  const loadMore = useCallback(async () => {
    if (!cursor || moreState.loading) return;
    setMoreState({ loading: true, error: '' });
    try {
      // The cursor goes back exactly as the server sent it (microsecond time, never rewritten via Date).
      const page = await utils.library.list.fetch({ cursor });
      setMore((current) => [...current, { documents: page.documents, nextCursor: page.nextCursor }]);
      setMoreState({ loading: false, error: '' });
    } catch (error) {
      setMoreState({ loading: false, error: libraryErrorMessage(error) });
    }
  }, [cursor, moreState.loading, utils]);

  const deleteDocument = useCallback(async (documentId: string) => {
    setDeleting((current) => new Set(current).add(documentId));
    try {
      await remove.mutateAsync({ documentId });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, message: libraryErrorMessage(error) };
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
      await reload();
    }
  }, [reload, remove]);

  const changePurpose = useCallback(async (documentId: string, purpose: LibraryPurpose) => {
    try {
      await setPurpose.mutateAsync({ documentId, purpose });
      // Patched in place so the loaded pages stay; the next reload reads it from the server.
      setPurposes((current) => ({ ...current, [documentId]: purpose }));
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, message: libraryErrorMessage(error) };
    }
  }, [setPurpose]);

  const documents = useMemo(
    () => raw.map((item) => ({
      ...item,
      purpose: purposes[item.id] ?? item.purpose,
      status: deleting.has(item.id) ? 'deleting' as const : item.status,
    })),
    [deleting, purposes, raw],
  );
  return {
    ready: list.isSuccess && !list.error, pending: list.isPending, error: list.error as unknown,
    documents, reload, loadMore, hasMore: !!cursor, moreState, deleteDocument, changePurpose,
    usedBytes: list.data?.usedBytes, capacityBytes: list.data?.capacityBytes,
    uploadEnabled: readUploadEnabled(list.data) && !disabledByServer,
    markDisabled,
  };
}
