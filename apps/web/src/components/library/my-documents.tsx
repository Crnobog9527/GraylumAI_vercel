'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/trpc/client';
import { useLibraryDocuments, type LibraryDocument } from '@/hooks/use-library-documents';
import { useLibraryUploads } from '@/hooks/use-library-uploads';
import { libraryErrorMessage } from '@/lib/library-documents/format';
import { isSignedStorageUrl, startDownload } from '@/lib/library-documents/signed-url';
import { DocumentList, SpacePanel, UploadPanel } from './my-documents-view';
import { DeleteConfirmDialog, DocumentDetailDialog } from './document-dialogs';
import styles from './my-documents.module.css';

/** 资料库「我的文档」(LIB-3). Upload stays hidden until the server's upload switch is on. */
export function MyDocuments() {
  const library = useLibraryDocuments();
  const { reload, markDisabled } = library;
  const uploads = useLibraryUploads(useCallback(() => { void reload(); }, [reload]), markDisabled);
  const download = trpc.library.download.useMutation();
  const [opened, setOpened] = useState<LibraryDocument | null>(null);
  const [confirming, setConfirming] = useState<LibraryDocument | null>(null);
  const [deleteState, setDeleteState] = useState({ pending: false, error: '' });
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!uploads.busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploads.busy]);

  async function onDownload(doc: LibraryDocument) {
    setBusyId(doc.id);
    try {
      const result = await download.mutateAsync({ documentId: doc.id });
      if (!isSignedStorageUrl(result.url)) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
      startDownload(result.url);
    } catch (error) {
      toast.error(libraryErrorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function onConfirmDelete() {
    if (!confirming) return;
    setDeleteState({ pending: true, error: '' });
    const result = await library.deleteDocument(confirming.id);
    if (result.ok) {
      setConfirming(null);
      setDeleteState({ pending: false, error: '' });
      if (opened?.id === confirming.id) setOpened(null);
    } else setDeleteState({ pending: false, error: result.message });
  }

  async function onPurpose(doc: LibraryDocument, purpose: 'authored' | 'reference') {
    setBusyId(doc.id);
    const result = await library.changePurpose(doc.id, purpose);
    setBusyId(null);
    if (!result.ok) toast.error(result.message);
  }

  const ready = library.ready;
  return <div className={styles.root}>
    <div className={styles.topRow}>
      <UploadPanel uploadEnabled={ready && library.uploadEnabled} spaceKnown={ready}
        usedBytes={library.usedBytes} capacityBytes={library.capacityBytes}
        uploads={uploads.items}
        onAdd={(files, purpose) => uploads.add(files, purpose, ready && library.capacityBytes !== undefined && library.usedBytes !== undefined
          ? library.capacityBytes - library.usedBytes : undefined)} onRetry={uploads.retry} onDismiss={uploads.dismiss}/>
      <SpacePanel usedBytes={ready ? library.usedBytes : undefined} capacityBytes={ready ? library.capacityBytes : undefined}/>
    </div>
    {!!library.error && <p role="alert" className={styles.error}>
      我的文档读取失败：{libraryErrorMessage(library.error)}{' '}
      <button type="button" className={styles.linkButton} onClick={() => { void library.reload(); }}>重试</button>
    </p>}
    {library.pending && <p role="status" className={styles.hint}>正在读取我的文档…</p>}
    <DocumentList documents={library.documents} ready={ready} busyId={busyId}
      onOpen={setOpened} onDownload={onDownload} onPurpose={onPurpose}
      onDelete={(doc) => { setDeleteState({ pending: false, error: '' }); setConfirming(doc); }}/>
    {(library.hasMore || library.moreState.error) && ready && <div className={styles.more}>
      {library.moreState.error && <span role="alert">{library.moreState.error}</span>}
      <button type="button" disabled={library.moreState.loading} onClick={() => library.loadMore()}>
        {library.moreState.loading ? '正在加载…' : '加载更多'}
      </button>
    </div>}
    {opened && <DocumentDetailDialog doc={opened} onClose={() => setOpened(null)}/>}
    {confirming && <DeleteConfirmDialog doc={confirming} pending={deleteState.pending} error={deleteState.error}
      onConfirm={onConfirmDelete} onClose={() => setConfirming(null)}/>}
  </div>;
}
