'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useMemo, useState } from 'react';
import { trpc } from '@/trpc/client';
import type { LibraryDocument } from '@/hooks/use-library-documents';
import { libraryErrorMessage } from '@/lib/library-documents/format';
import styles from './my-documents.module.css';

/** Segments shown per screen (the range endpoint allows up to 50). */
export const READER_PAGE = 5;

export type Chapter = { ordinal: number; title: string };
/** One directory entry per heading: consecutive segments under the same title collapse into one. */
export function chaptersOf(directory: Array<{ ordinal: number; title: string }>): Chapter[] {
  const chapters: Chapter[] = [];
  let previous = '';
  for (const entry of directory) {
    if (entry.title && entry.title !== previous) chapters.push({ ordinal: entry.ordinal, title: entry.title });
    previous = entry.title;
  }
  return chapters;
}

/** Text documents: the whole directory once (titles only), then the body a few segments at a time. */
export function DocumentReader({ doc }: { doc: LibraryDocument }) {
  const [start, setStart] = useState(0);
  const input = { documentId: doc.id, version: doc.content_version };
  const directory = trpc.library.directory.useQuery(input, { staleTime: 60_000, retry: false });
  const page = trpc.library.segments.useQuery({ ...input, start, count: READER_PAGE }, { staleTime: 30_000, retry: false });
  const chapters = useMemo(() => chaptersOf(directory.data ?? []), [directory.data]);
  const starts = useMemo(() => new Set(chapters.map((chapter) => chapter.ordinal)), [chapters]);
  const total = directory.data?.length;

  const error = directory.error ?? page.error;
  if (error) return <p role="alert" className={styles.error}>{libraryErrorMessage(error)}</p>;
  if (directory.isPending) return <p className={styles.hint}>正在读取内容…</p>;
  if (!total) return <p className={styles.hint}>这个文件没有可显示的文字。</p>;
  const segments = page.data ?? [];
  const last = Math.min(total, start + READER_PAGE);
  const current = [...chapters].reverse().find((chapter) => chapter.ordinal <= start);

  return <div className={styles.reader}>
    {chapters.length > 0 && <nav className={styles.toc} aria-label="目录">
      <h3>目录</h3>
      <ol>
        {chapters.map((chapter) => <li key={chapter.ordinal}>
          <button type="button" aria-current={current?.ordinal === chapter.ordinal ? 'true' : undefined}
            onClick={() => setStart(chapter.ordinal)}>{chapter.title}</button>
        </li>)}
      </ol>
    </nav>}
    <div className={styles.readerBody}>
      <p className={styles.hint}>第 {start + 1}–{last} 段，共 {total} 段{current ? ' · ' + current.title : ''}</p>
      {page.isPending && <p className={styles.hint}>正在读取内容…</p>}
      {segments.map((segment) => <section key={segment.ordinal} className={styles.segment} aria-label={'第 ' + (segment.ordinal + 1) + ' 段'}>
        {starts.has(segment.ordinal) && <h4>{segment.title}</h4>}
        {segment.body}
      </section>)}
      <nav className={styles.segmentNav} aria-label="分段翻页">
        <button type="button" disabled={start === 0} onClick={() => setStart(Math.max(0, start - READER_PAGE))}>上一页</button>
        <span>{last >= total ? '已到最后' : ''}</span>
        <button type="button" disabled={last >= total} onClick={() => setStart(start + READER_PAGE)}>下一页</button>
      </nav>
    </div>
  </div>;
}
