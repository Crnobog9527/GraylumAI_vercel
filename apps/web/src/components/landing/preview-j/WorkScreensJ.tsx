/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { CSSProperties } from 'react';
import { Check, Minus, Sparkles } from 'lucide-react';
import library from '@/app/library/library.module.css';
import result from '@/components/opc/positioning-result.module.css';
import { UploadPanel } from '@/components/library/my-documents-view';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { UploadItem } from '@/hooks/use-library-uploads';
import { J_PERSONA } from '@/lib/landing/landing-copy-j-persona';
import type { WorkBlock } from '@/lib/landing/landing-copy-j-work';
import styles from './work-j.module.css';

const noop = () => undefined;
const FILES = ['以前发的做饭记录.txt', '小红书旧笔记.md'];
const LIBRARY_ROWS = [
  { title: '冰箱剩菜三种做法', draft: '待创作', published: '未发布', fresh: true },
  { title: '一口锅两菜一汤', draft: '已定稿', published: '已发布', fresh: false },
  { title: '超市半成品像现做', draft: '草稿', published: '未发布', fresh: false },
];
const PLATFORMS = [['TikTok', true], ['Instagram', true], ['YouTube', true], ['Facebook', false]] as const;

/**
 * One step's screen: its blocks in order, each arriving a beat after the one before (`--i`) when the step opens, so
 * the reader follows the coach. The screen grows with its content: nothing is cut off. Everything is a picture.
 */
export function WorkScreenJ({ blocks }: { blocks: readonly WorkBlock[] }) {
  return (
    <div className={styles.chat}>
      {blocks.map((block, index) => (
        <div key={index} className={styles.block} style={{ '--i': index } as CSSProperties} data-kind={block.kind}>
          <Block block={block} />
        </div>
      ))}
    </div>
  );
}

function Block({ block }: { block: WorkBlock }) {
  switch (block.kind) {
    case 'user': return <div className={styles.user}><span>你</span><p>{block.text}</p></div>;
    case 'coach':
      return (
        <div className={styles.coach}>
          <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />AI 自媒体陪跑教练</span>
          <p>{block.text}</p>
        </div>
      );
    case 'note': return <p className={styles.note}>{block.text}</p>;
    case 'checks':
      return (
        <div className={styles.doing}>
          {block.title ? <p className={styles.blockTitle}>{block.title}</p> : null}
          <ul className={styles.fetch}>{block.items.map(item => <li key={item} data-done=""><Check size={14} aria-hidden="true" />{item}</li>)}</ul>
        </div>
      );
    case 'options':
      return (
        <ul className={styles.options}>
          {block.items.map(item => (
            <li key={item.title} data-tag={item.tag || undefined}>
              <b>{item.title}</b><span>{item.note}</span>{item.tag ? <em>{item.tag}</em> : null}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className={styles.tableWrap}>
          {block.title ? <p className={styles.blockTitle}>{block.title}</p> : null}
          <table className={styles.table}>
            <thead><tr>{block.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>
              {block.rows.map(row => (
                <tr key={row[0]}>
                  {row.map((cell, index) => (index === 0
                    ? <th key={index} scope="row">{cell}</th>
                    : <td key={index} data-label={block.columns[index]}>{cell}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'rows':
      return (
        <div className={styles.rowsWrap}>
          {block.title ? <p className={styles.blockTitle}>{block.title}</p> : null}
          <dl className={styles.rows}>{block.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </div>
      );
    case 'trend':
      return (
        <div className={styles.trend}>
          <span>{block.label}</span>
          <svg viewBox="0 0 200 50" preserveAspectRatio="none" aria-hidden="true">
            <path className={styles.trendFill} d="M0 40 C 30 40 60 41 90 39 S 140 22 200 8 L 200 50 L 0 50 Z" />
            <path className={styles.trendLine} d="M0 40 C 30 40 60 41 90 39 S 140 22 200 8" />
          </svg>
        </div>
      );
    case 'compare':
      return (
        <div className={styles.compare}>
          <div><span>{block.left.label}</span><ol>{block.left.lines.map(line => <li key={line}><Minus size={13} aria-hidden="true" />{line}</li>)}</ol></div>
          <div>
            <span><Sparkles size={13} aria-hidden="true" />{block.right.label}</span>
            <ol>{block.right.lines.map(line => <li key={line}>{line}</li>)}</ol>
          </div>
        </div>
      );
    case 'library': return <Library fresh={block.fresh} />;
    case 'upload': return <Upload done={block.done} />;
    case 'publish': return <Publish sent={block.sent} />;
  }
}

/** The library page's own catalog styles, with this person's topics. */
function Library({ fresh }: { fresh: boolean }) {
  const rows = LIBRARY_ROWS.filter(row => fresh || !row.fresh);
  return (
    <div className={styles.library}>
      <header className={library.header}><span className={styles.libraryTitle}>资料库</span></header>
      <nav className={library.tabs} aria-label="资料库分类">
        <button type="button" role="tab" aria-selected tabIndex={-1}>选题与稿件</button>
        <button type="button" role="tab" aria-selected={false} tabIndex={-1}>我的文档</button>
      </nav>
      <p className={library.intro}>按平台和账号查看已采用选题、稿件和当前定位。</p>
      <div className={styles.libraryRows}>
        {rows.map(row => (
          <article key={row.title} className={library.item} data-fresh={(fresh && row.fresh) || undefined}>
            <div className={library.itemOpen}>
              <span><strong>{row.title}</strong><small>短视频</small></span>
              <span>TikTok<small>{J_PERSONA.account}</small></span>
              <span>{row.draft}</span>
              <span>{row.published}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

/** The library's real upload panel, with two of this person's old writings uploading as "我本人写的". */
function Upload({ done }: { done: boolean }) {
  const uploads: UploadItem[] = FILES.map((filename, index) => ({
    key: filename, filename, purpose: 'authored', status: done ? 'done' : index === 0 ? 'transfer' : 'waiting', progress: 0.6,
  }));
  return (
    <div className={styles.upload}>
      <UploadPanel uploadEnabled spaceKnown usedBytes={0} capacityBytes={500_000_000} uploads={uploads}
        onAdd={noop} onRetry={noop} onDismiss={noop} />
    </div>
  );
}

/** Publishing, built from the product's checkbox and button (the product has no publish page yet). */
function Publish({ sent }: { sent: boolean }) {
  return (
    <div className={styles.publish}>
      <ul>
        {PLATFORMS.map(([name, on]) => (
          <li key={name}><Checkbox checked={on} tabIndex={-1} />{name}{sent && on ? <em>已发布</em> : null}</li>
        ))}
      </ul>
      <Button size="sm" tabIndex={-1} className={styles.send} data-done={sent || undefined}>
        {sent ? <><Check size={14} aria-hidden="true" />已发出，资料库已记为已发布</> : '确认发出'}
      </Button>
    </div>
  );
}
