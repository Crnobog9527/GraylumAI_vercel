'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { IMPORT_READ_HINT, type ImportReadNotice } from '@/lib/voice/import-read';
import { IMPORT_NOTE, importPlatformName, type ImportCandidate, type ImportSource } from '@/lib/voice/format';
import styles from './my-voice.module.css';

export type ImportPostsViewProps = { sources: ImportSource[] | null; busy: boolean; open: string | null;
  candidates: ImportCandidate[] | null; picked: string[]; onOpen: (connectionId: string | null) => void;
  onPick: (postId: string) => void; onImport: () => void;
  /** "读取最新帖子": the connection being read, the last read's notice, and the button's action. */
  reading?: string | null; notice?: ({ connectionId: string } & ImportReadNotice) | null; onRead?: (connectionId: string) => void };

/** VOICE-2 PR-6: 「从我的账号导入」— the user's own posts from the latest paid read of a connected account (数据复盘). */
export function ImportPostsView(props: ImportPostsViewProps) {
  const { sources, busy } = props;
  return <section className={styles.panel} aria-label="从我的账号导入">
    <DisplayHeading as="h2">从我的账号导入</DisplayHeading>
    <p className={styles.hint}>{IMPORT_NOTE}</p>
    {sources === null ? <p className={styles.hint}>正在读取已连接的账号…</p>
      : !sources.length ? <p className={styles.hint}>还没有连接自己的账号。<Link prefetch={false} href="/app/publish-monitor">去数据复盘连接</Link></p>
      : <ul className={styles.importSources}>{sources.map(source => {
        const name = `${importPlatformName(source.platform)}${source.displayHint ? ` · ${source.displayHint}` : ''}`;
        const opened = props.open === source.connectionId;
        return <li key={source.connectionId}>
          <div className={styles.importHead}>
            <span className={styles.labelName}>{name}</span>
            {!source.supported ? <small>这个账号暂不支持导入</small> : <span className={styles.importButtons}>
              <button type="button" disabled={busy} onClick={() => props.onRead?.(source.connectionId)}>
                {props.reading === source.connectionId ? '正在读取…' : '读取最新帖子'}</button>
              {source.posts > 0 && <button type="button" disabled={busy} onClick={() => props.onOpen(opened ? null : source.connectionId)}>
                {opened ? '收起' : `选择帖子（${source.posts}）`}</button>}
            </span>}
          </div>
          {source.supported && <small className={styles.importState}>{source.posts > 0 && source.fetchedAt
            ? `最近一次读到 ${source.posts} 条（${source.fetchedAt.slice(0, 10)}）。` : '还没有读到帖子。'}{IMPORT_READ_HINT}</small>}
          {props.notice?.connectionId === source.connectionId && <p role={props.notice.tone === 'error' ? 'alert' : 'status'}
            className={props.notice.tone === 'error' ? styles.importError : styles.hint}>{props.notice.text}</p>}
          {opened && <ImportList {...props} />}
        </li>;
      })}</ul>}
  </section>;
}

function ImportList({ candidates, picked, busy, onPick, onImport }: ImportPostsViewProps) {
  if (candidates === null) return <p className={styles.hint}>正在读取帖子…</p>;
  if (!candidates.length) return <p className={styles.hint}>没有可以导入的帖子。</p>;
  return <div className={styles.importList}>
    <ul>{candidates.map(post => <li key={post.postId}>
      <label><input type="checkbox" disabled={busy || post.imported} checked={post.imported || picked.includes(post.postId)}
        onChange={() => onPick(post.postId)} />
        <span>{post.text}</span>
        <small>{post.imported ? '已导入' : post.postedAt?.slice(0, 10) ?? ''}</small></label>
    </li>)}</ul>
    <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={busy || !picked.length} onClick={onImport}>
        {busy ? '正在导入…' : `导入所选（${picked.length}）`}</button>
    </div>
  </div>;
}
