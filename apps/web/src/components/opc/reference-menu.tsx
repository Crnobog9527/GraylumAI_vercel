'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, useState, type RefObject } from 'react';
import { trpc } from '@/trpc/client';
import type { ComposerEditorHandle, ComposerReferenceHooks } from './composer-editor';
import type { LibraryReference, ReferenceQuery } from './composer-references';
import { QueryNotice } from './query-notice';
import { ReferenceMenuView } from './composer-view';
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
const sameReferences = (a: LibraryReference[], b: LibraryReference[]) =>
  a.length === b.length && a.every((item, index) => item.documentId === b[index].documentId);

/**
 * UI-B skeleton wiring for the message box. Disabled, it returns nothing and the box is exactly UI-A.
 * `references` is kept for the later LIB-4 wiring; nothing here sends it.
 */
export function useComposerReferences(enabled: boolean, box: RefObject<ComposerEditorHandle | null>) {
  const [query, setQuery] = useState<ReferenceQuery | null>(null);
  // Transactions can arrive before React re-renders; compare against the latest reported query.
  const current = useRef<ReferenceQuery | null>(null);
  const [references, setReferences] = useState<LibraryReference[]>([]);
  // Esc hides the menu for this `@` only; typing a new `@` opens it again.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState('');
  const open = enabled && query !== null && query.from !== dismissed;
  const list = trpc.library.list.useQuery({}, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
  const choices = open ? matchingDocuments(list.data?.documents ?? [], query.query) : [];
  const highlighted = choices.length ? Math.min(active, choices.length - 1) : -1;

  const pick = (item: ListedDocument) => {
    if (!query || box.current?.insertReference(query, referenceFor(item))) return;
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
      setReferences(old => sameReferences(old, next.references) ? old : next.references);
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
      if (confirming && list.isLoading) return true;
      // A highlighted choice takes Enter/Tab; once loaded with nothing to pick, Enter keeps its usual meaning.
      if (confirming && highlighted >= 0) {
        pick(choices[highlighted]);
        return true;
      }
      return false;
    },
  };

  const menu = open ? <ReferenceMenuView choices={choices.map(item => ({ id: item.id, label: item.filename ?? '未命名文档' }))}
    highlighted={highlighted} onPick={index => pick(choices[index])}
    status={list.isLoading ? <p role="status">正在读取资料库…</p>
      : list.error ? <QueryNotice error={list.error} label="资料库" retry={() => list.refetch()}/> : undefined}/>
    : notice ? <p role="alert" className={styles.note}>{notice}</p> : null;

  return { hooks: enabled ? hooks : undefined, menu, references };
}
