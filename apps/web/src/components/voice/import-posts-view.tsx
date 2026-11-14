'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import Link from 'next/link';
import { DisplayHeading } from '@/components/chat-display/display-heading';
import { IMPORT_NOTE, importPlatformName, importWaitText, type ImportCandidate, type ImportSource } from '@/lib/voice/format';
import styles from './my-voice.module.css';

export type ImportPostsViewProps = { sources: ImportSource[] | null; busy: boolean; open: string | null;
  candidates: ImportCandidate[] | null; picked: string[]; onOpen: (connectionId: string | null) => void;
  onPick: (postId: string) => void; onImport: () => void };

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
            {!source.supported ? <small>这个账号暂不支持导入</small>
              : !source.posts ? <small>{importWaitText(source.autoTrack)}<Link prefetch={false} href="/app/publish-monitor">去数据复盘</Link></small>
              : <button type="button" disabled={busy} onClick={() => props.onOpen(opened ? null : source.connectionId)}>
                {opened ? '收起' : `选择帖子（${source.posts}）`}</button>}
          </div>
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
