'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useCallback, useState, type RefObject } from 'react';
import { trpc } from '@/trpc/client';
import { useLibraryUploads, type UploadItem } from '@/hooks/use-library-uploads';
import { extensionOf, isPdfUploadReady, isWordUploadReady } from '@/lib/library-documents/format';
import type { ComposerEditorHandle } from './composer-editor';
import { REFERENCE_LIMIT } from './composer-references';
import { REFERENCE_LIMIT_NOTICE, referenceFor } from './reference-menu';
import styles from './work-composer.module.css';

/**
 * UI-C (Master Plan task table; D6 and the 2026-10-10 decision): a file added in the message box is uploaded into the
 * user's library through the library's own upload flow (no second upload path) and joins the message as an @ reference.
 * Only documents with text: the Agent does not read images in the first version, so images stay on the library page.
 */
export function attachmentExtensions() {
  return ['txt', 'md', ...(isWordUploadReady() ? ['docx'] : []), ...(isPdfUploadReady() ? ['pdf'] : [])];
}
export function attachmentAccept() {
  return attachmentExtensions().map(extension => '.' + extension).join(',');
}
export function attachmentFormatsText() {
  return ['TXT', 'Markdown', ...(isWordUploadReady() ? ['Word'] : []), ...(isPdfUploadReady() ? ['PDF'] : [])].join('、');
}
/** The refusal for a file the message box does not take, or null; size and name are checked by the library flow. */
export function attachmentRefusal(name: string): string | null {
  if (attachmentExtensions().includes(extensionOf(name))) return null;
  return `「${name}」不能作为附件：这里只支持 ${attachmentFormatsText()} 文档。图片请到资料库上传。`;
}

const STAGE: Partial<Record<UploadItem['status'], string>> = {
  waiting: '等待上传', extract: '正在读取文字', begin: '正在存入资料库', transfer: '正在存入资料库', complete: '正在存入资料库',
  removing: '正在移除',
};

export function useComposerAttachments(box: RefObject<ComposerEditorHandle | null>) {
  const utils = trpc.useUtils();
  const [notices, setNotices] = useState<string[]>([]);
  const [linking, setLinking] = useState(0);
  const say = (text: string) => setNotices(list => [...list, text]);

  // A finished file is found by name among the ready documents (#933 search) to learn its content version.
  const onUploaded = useCallback(async (item: UploadItem, documentId: string) => {
    setLinking(count => count + 1);
    try {
      await utils.library.invalidate();
      const found = (await utils.library.search.fetch({ query: item.filename.slice(0, 100) })).documents
        .find(document => document.id === documentId);
      if (!found) {
        say(`「${item.filename}」已存入资料库，文字还在处理（扫描页要先识别），处理好后可以用 @ 引用。`);
        return;
      }
      const reference = referenceFor(found);
      // Read from the box itself and append in the same synchronous step: uploads finishing together each see the
      // references the previous one just added, so together they never pass five.
      const inBox = box.current?.currentReferences() ?? [];
      if (inBox.length >= REFERENCE_LIMIT && !inBox.some(other => other.documentId === reference.documentId)) {
        say(`「${item.filename}」已存入资料库，但${REFERENCE_LIMIT_NOTICE}`);
        return;
      }
      if (!box.current?.appendReference(reference))
        say(`「${item.filename}」已存入资料库，但加入引用会超过字数上限；删减内容后可以用 @ 引用。`);
    } catch {
      say(`「${item.filename}」已存入资料库，但暂时没能加入本条消息；可以用 @ 引用它。`);
    } finally {
      setLinking(count => count - 1);
    }
  }, [box, utils]);
  const uploads = useLibraryUploads(useCallback(() => {}, []), useCallback(() => say('资料库暂时不能上传文件，请稍后再试。'), []),
    (item, documentId) => void onUploaded(item, documentId));

  function add(files: File[]) {
    setNotices([]);
    const accepted = files.filter(file => {
      const refusal = attachmentRefusal(file.name);
      if (refusal) say(refusal);
      return !refusal;
    });
    if (accepted.length) uploads.add(accepted, 'reference');
  }

  // A finished PDF with scanned pages keeps its line: only the pages with text are readable until they are recognised.
  const shown = uploads.items.filter(item => item.status !== 'done' || item.message);
  // `uploads.busy` also covers a failed upload whose server row is still unresolved (outcome unknown): sending waits
  // until the user retries or removes it, so the message never goes out missing a file that may yet exist.
  const busy = linking > 0 || uploads.busy;
  const status = shown.length || notices.length ? <div className={styles.note} aria-label="附件">
    {shown.map(item => <p key={item.key} role={item.status === 'failed' || item.status === 'rejected' ? 'alert' : 'status'}>
      <span>{item.filename}：{STAGE[item.status] ?? item.message ?? '上传失败'}{STAGE[item.status] ? '…' : ''}</span>
      {item.status === 'done' && <button type="button" onClick={() => void uploads.dismiss(item.key)}>知道了</button>}
      {item.status === 'failed' && <button type="button" onClick={() => uploads.retry(item.key)}>重试</button>}
      {(item.status === 'failed' || item.status === 'rejected')
        && <button type="button" onClick={() => void uploads.dismiss(item.key)}>移除</button>}
    </p>)}
    {notices.map((text, index) => <p key={index} role="alert">{text}</p>)}
  </div> : null;
  return { add, busy, status };
}
