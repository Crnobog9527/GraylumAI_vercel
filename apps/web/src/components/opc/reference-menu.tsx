'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, useState, type RefObject } from 'react';
import { FileText } from 'lucide-react';
import { trpc } from '@/trpc/client';
import type { ComposerEditorHandle, ComposerReferenceHooks } from './composer-editor';
import { REFERENCE_LIMIT, sameReferences, type LibraryReference, type ReferenceQuery } from './composer-references';
import { QueryNotice } from './query-notice';
import styles from './work-composer.module.css';

type ListedDocument = {
  id: string; kind: string; status: string; filename: string | null; content_version: number;
};

const SHOWN = 8;

/** Ready text documents whose name contains the query (case-insensitive), at most eight, in list order. */
export function matchingDocuments<T extends ListedDocument>(documents: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return documents.filter(item => item.kind === 'document' && item.status === 'ready'
    && (item.filename ?? '').toLocaleLowerCase().includes(needle)).slice(0, SHOWN);
}

export function referenceFor(item: ListedDocument): LibraryReference {
  return { documentId: item.id, version: item.content_version, label: item.filename ?? '未命名文档' };
}

const sameQuery = (a: ReferenceQuery | null, b: ReferenceQuery | null) =>
  a === b || (!!a && !!b && a.from === b.from && a.to === b.to && a.query === b.query);
export const REFERENCE_LIMIT_NOTICE = `每条消息最多引用 ${REFERENCE_LIMIT} 篇文档。`;

/**
 * UI-B picker for the message box. Disabled, it returns nothing and the box is exactly UI-A.
 * `onReferences` hears every change of the references in the box; the page sends them with the message.
 * An empty `@` lists the most recent documents; typed text searches every document by file name on the server (#933).
 */
export function useComposerReferences(enabled: boolean, box: RefObject<ComposerEditorHandle | null>,
  onReferences?: (references: LibraryReference[]) => void) {
  const [query, setQuery] = useState<ReferenceQuery | null>(null);
  // Transactions can arrive before React re-renders; compare against the latest reported query.
  const current = useRef<ReferenceQuery | null>(null);
  const [references, setReferences] = useState<LibraryReference[]>([]);
  const reported = useRef<LibraryReference[]>([]);
  // Esc hides the menu for this `@` only; typing a new `@` opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const open = enabled && query !== null && query.from !== dismissed;
  const needle = open ? query.query.trim() : '';
  const recent = trpc.library.list.useQuery({}, { enabled: open && !needle, staleTime: 60_000, refetchOnWindowFocus: false });
  const found = trpc.library.search.useQuery({ query: needle }, {
    enabled: open && Boolean(needle), staleTime: 30_000, refetchOnWindowFocus: false, placeholderData: previous => previous,
  });
  const list = needle ? found : recent;
  // A previous search's answer is shown while the new one loads, filtered by the new text, but never picked by Enter.
  const loading = list.isLoading || (needle !== '' && found.isPlaceholderData);
  const choices = open ? matchingDocuments(list.data?.documents ?? [], query.query) : [];
  const highlighted = choices.length ? Math.min(active, choices.length - 1) : -1;

  const pick = (item: ListedDocument) => {
    if (!query) return;
    if (references.length >= REFERENCE_LIMIT && !references.some(other => other.documentId === item.id)) {
      setDismissed(query.from);
      setNotice(REFERENCE_LIMIT_NOTICE);
      return;
    }
    if (box.current?.insertReference(query, referenceFor(item))) return;
    // Did not fit: close this menu so Enter sends again, and say why.
    setDismissed(query.from);
    setNotice('加入这个引用会超过字数上限，请先删减内容。');
  };
  const hooks: ComposerReferenceHooks = {
    onState: next => {
      const previous = current.current;
      if (!sameQuery(previous, next.query)) {
        current.current = next.query;
        setQuery(next.query);
        if (previous?.query !== next.query?.query) {
          setActive(0);
          setNotice('');
        }
        if (!next.query) setDismissed(null);
      }
      if (!sameReferences(reported.current, next.references)) {
        reported.current = next.references;
        setReferences(next.references);
        onReferences?.(next.references);
      }
    },
    onMenuKey: event => {
      if (!open || event.altKey || event.ctrlKey || event.metaKey) return false;
      if (event.key === 'Escape') {
        setDismissed(query.from);
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!choices.length) return false;
        const step = event.key === 'ArrowDown' ? 1 : choices.length - 1;
        setActive((highlighted + step) % choices.length);
        return true;
      }
      const confirming = event.key === 'Enter' && !event.shiftKey || event.key === 'Tab';
      // While the list is loading, Enter waits instead of sending the literal `@text`.
      if (confirming && loading) return true;
      // A highlighted choice takes Enter/Tab; once loaded with nothing to pick, Enter keeps its usual meaning.
      if (confirming && highlighted >= 0) {
        pick(choices[highlighted]);
        return true;
      }
      return false;
    },
  };

  const menu = open ? <div className={styles.referenceMenu} role="dialog" aria-label="引用资料库文档">
    {loading && !choices.length ? <p role="status">正在读取资料库…</p>
      : list.error ? <QueryNotice error={list.error} label="资料库" retry={() => list.refetch()}/>
        : choices.length ? <div role="listbox" aria-label="资料库文档">{choices.map((item, index) =>
          <button type="button" role="option" key={item.id} aria-selected={index === highlighted}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(item)}>
            <FileText size={15}/><span>{item.filename ?? '未命名文档'}</span>
          </button>)}</div>
          : <p>没有匹配的已就绪文档</p>}
    <small>{REFERENCE_LIMIT_NOTICE}AI 会按需读取引用文档的内容。</small>
  </div> : notice ? <p role="alert" className={styles.note}>{notice}</p> : null;

  return { hooks: enabled ? hooks : undefined, menu, references };
}
