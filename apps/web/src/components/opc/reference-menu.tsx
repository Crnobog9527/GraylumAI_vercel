'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useRef, useState, type RefObject } from 'react';
import { FileText } from 'lucide-react';
import { trpc } from '@/trpc/client';
import type { ComposerEditorHandle, ComposerReferenceHooks } from './composer-editor';
import type { LibraryReference, ReferenceQuery } from './composer-references';
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
  const open = enabled && query !== null && query.from !== dismissed;
  const list = trpc.library.list.useQuery({}, { enabled: open, staleTime: 60_000, refetchOnWindowFocus: false });
  const choices = open ? matchingDocuments(list.data?.documents ?? [], query.query) : [];
  const highlighted = choices.length ? Math.min(active, choices.length - 1) : -1;

  const pick = (item: ListedDocument) => {
    if (query) box.current?.insertReference(query, referenceFor(item));
  };
  const hooks: ComposerReferenceHooks = {
    onState: next => {
      const previous = current.current;
      if (!sameQuery(previous, next.query)) {
        current.current = next.query;
        setQuery(next.query);
        if (previous?.query !== next.query?.query) setActive(0);
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
      // A highlighted choice takes Enter/Tab; with nothing to pick, Enter keeps its usual meaning.
      if ((event.key === 'Enter' && !event.shiftKey || event.key === 'Tab') && highlighted >= 0) {
        pick(choices[highlighted]);
        return true;
      }
      return false;
    },
  };

  const menu = open ? <div className={styles.referenceMenu} role="dialog" aria-label="引用资料库文档">
    {list.isLoading ? <p role="status">正在读取资料库…</p>
      : list.error ? <QueryNotice error={list.error} label="资料库" retry={() => list.refetch()}/>
        : choices.length ? <div role="listbox" aria-label="资料库文档">{choices.map((item, index) =>
          <button type="button" role="option" key={item.id} aria-selected={index === highlighted}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(item)}>
            <FileText size={15}/><span>{item.filename ?? '未命名文档'}</span>
          </button>)}</div>
          : <p>没有匹配的已就绪文档</p>}
    <small>引用尚未开放：选中的文档暂时不会发送给 AI。</small>
  </div> : null;

  return { hooks: enabled ? hooks : undefined, menu, references };
}
