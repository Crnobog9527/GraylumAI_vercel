/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useCallback, useMemo, useState } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@repo/api/src/root';
import { trpc } from '@/trpc/client';
import { libraryErrorMessage, type LibraryPurpose } from '@/lib/library-documents/format';

type ListOutput = inferRouterOutputs<AppRouter>['library']['list'];
export type LibraryDocument = ListOutput['documents'][number];
const PAGE = 50;

/**
 * The upload switch (system setting `library_upload_enabled`) is reported by the list response as
 * `uploadEnabled`. Until the server reports `true`, the page shows no upload entry (fail closed).
 */
export function readUploadEnabled(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { uploadEnabled?: unknown }).uploadEnabled === true;
}

export function useLibraryDocuments() {
  const list = trpc.library.list.useQuery({}, { refetchOnMount: 'always', refetchOnWindowFocus: true });
  const utils = trpc.useUtils();
  const [more, setMore] = useState<LibraryDocument[]>([]);
  const [moreState, setMoreState] = useState<{ loading: boolean; exhausted: boolean; error: string }>({
    loading: false, exhausted: false, error: '',
  });
  const [disabledByServer, setDisabledByServer] = useState(false);
  const remove = trpc.library.delete.useMutation();
  const setPurpose = trpc.library.setPurpose.useMutation();
  const [deleting, setDeleting] = useState<Set<string>>(() => new Set());

  const { refetch } = list;
  const reload = useCallback(async () => {
    setMore([]);
    setMoreState({ loading: false, exhausted: false, error: '' });
    await refetch();
  }, [refetch]);

  const firstPage = useMemo(() => list.data?.documents ?? [], [list.data]);
  const markDisabled = useCallback(() => setDisabledByServer(true), []);
  const raw = useMemo(() => {
    const seen = new Set<string>();
    return [...firstPage, ...more].filter((item) => !seen.has(item.id) && !!seen.add(item.id));
  }, [firstPage, more]);
  const hasMore = !moreState.exhausted && (more.length ? more.length % PAGE === 0 : firstPage.length === PAGE);

  const loadMore = useCallback(async () => {
    const last = raw.at(-1);
    if (!last || moreState.loading) return;
    setMoreState((state) => ({ ...state, loading: true, error: '' }));
    try {
      const page = await utils.library.list.fetch({ afterId: last.id });
      setMore((current) => [...current, ...page.documents]);
      setMoreState({ loading: false, exhausted: page.documents.length < PAGE, error: '' });
    } catch (error) {
      setMoreState((state) => ({ ...state, loading: false, error: libraryErrorMessage(error) }));
    }
  }, [moreState.loading, raw, utils]);

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
      await reload();
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, message: libraryErrorMessage(error) };
    }
  }, [reload, setPurpose]);

  const documents = useMemo(
    () => raw.map((item) => (deleting.has(item.id) ? { ...item, status: 'deleting' as const } : item))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [deleting, raw],
  );
  return {
    ready: list.isSuccess && !list.error, pending: list.isPending, error: list.error as unknown,
    documents, reload, loadMore, hasMore, moreState, deleteDocument, changePurpose,
    usedBytes: list.data?.usedBytes, capacityBytes: list.data?.capacityBytes,
    uploadEnabled: readUploadEnabled(list.data) && !disabledByServer,
    markDisabled,
  };
}
