'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useState, type ReactNode } from 'react';
import { trpc } from '@/trpc/client';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import { libraryErrorMessage } from '@/lib/library-documents/format';
import { isSignedStorageUrl } from '@/lib/library-documents/signed-url';
import { DocumentReader } from './document-reader';
import styles from './my-documents.module.css';

function Dialog({ label, title, onClose, closable = true, children }: {
  label: string; title: string; onClose: () => void; closable?: boolean; children: ReactNode;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && closable) onClose(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [closable, onClose]);
  return <div className={styles.backdrop} onMouseDown={(event) => {
    if (event.target === event.currentTarget && closable) onClose();
  }}>
    <div role="dialog" aria-modal="true" aria-label={label} className={styles.dialog}>
      <header className={styles.dialogHead}><h2>{title}</h2>
        <button type="button" aria-label="关闭窗口" disabled={!closable} onClick={onClose}>×</button></header>
      <div className={styles.dialogBody}>{children}</div>
    </div>
  </div>;
}

export function DeleteConfirmDialog({ doc, pending, error, onConfirm, onClose }: {
  doc: LibraryDocument; pending: boolean; error: string; onConfirm: () => void; onClose: () => void;
}) {
  const name = doc.filename ?? '这个文件';
  return <Dialog label="确认删除文件" title={'删除「' + name + '」？'} onClose={onClose} closable={!pending}>
    <ul className={styles.impact}>
      <li>删除后立即不能再查看、下载或预览，Agent 也读不到这个文件。</li>
      <li>删除前刚打开的下载或预览链接，最多还能使用 60 秒。</li>
      <li>原文件、提取出的文字和分段会被彻底删除（最晚 24 小时内完成），没有回收站，不能恢复。</li>
      <li>已经显示在对话里的回答和你保存的成果不会跟着删除，需要的话可以另外删除。</li>
      <li>删除完成前，列表会显示「删除中」，这部分空间暂时还不会释放。</li>
    </ul>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.dialogActions}>
      <button type="button" disabled={pending} onClick={onClose}>取消</button>
      <button type="button" className={styles.confirm} disabled={pending} onClick={onConfirm}>
        {pending ? '删除中…' : '确认删除'}
      </button>
    </div>
  </Dialog>;
}

export function DocumentDetailDialog({ doc, onClose }: { doc: LibraryDocument; onClose: () => void }) {
  const name = doc.filename ?? '文件';
  return <Dialog label="查看文件" title={name} onClose={onClose}>
    {doc.kind === 'image' ? <ImagePreview doc={doc}/> : <DocumentReader doc={doc}/>}
  </Dialog>;
}

function ImagePreview({ doc }: { doc: LibraryDocument }) {
  const preview = trpc.library.preview.useMutation();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const { mutateAsync } = preview;
  useEffect(() => {
    let live = true;
    mutateAsync({ documentId: doc.id }).then((result) => {
      if (!live) return;
      if (isSignedStorageUrl(result.url)) setUrl(result.url);
      else setError('暂时无法预览，请稍后重试。');
    }, (cause: unknown) => { if (live) setError(libraryErrorMessage(cause)); });
    return () => { live = false; };
  }, [doc.id, mutateAsync]);
  if (error) return <p role="alert" className={styles.error}>{error}</p>;
  if (!url) return <p className={styles.hint}>正在加载预览…</p>;
  // Private signed URL on the storage origin; plain <img>, no image optimizer or server decoding.
  return <img className={styles.image} src={url} alt={doc.filename ?? '图片预览'} referrerPolicy="no-referrer"/>;
}
