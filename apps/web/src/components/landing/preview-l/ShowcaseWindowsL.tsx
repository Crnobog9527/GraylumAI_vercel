/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { CSSProperties, ReactNode } from 'react';
import library from '@/app/library/library.module.css';
import work from '@/app/runtime/runtime-work.module.css';
import styles from './l.module.css';
import showcase from './showcase-l.module.css';

/** The work chat's head as the product shows it for a work item: platform · account (runtime/page.tsx), as in region 3. */
const ACCOUNT = 'TikTok · 下班后 15 分钟家常菜';
/** The work chat's own name for a conversation without a single work item (runtime/page.tsx). */
const TITLE = '工作对话';

/**
 * The library page's head and tabs (app/library/page.tsx and library.module.css) in region 3's window frame, on
 * the "我的文档" tab with that tab's own intro line. The page's h1 becomes plain text: the window is a picture.
 */
export function LibraryWindowL({ children }: { children: ReactNode }) {
  return (
    <div className={styles.workWindow} inert aria-hidden="true">
      <header className={library.header}><span className={showcase.libraryTitle}>资料库</span></header>
      <nav className={library.tabs} aria-label="资料库分类">
        <button type="button" role="tab" aria-selected={false} tabIndex={-1}>选题与稿件</button>
        <button type="button" role="tab" aria-selected tabIndex={-1}>我的文档</button>
      </nav>
      <p className={library.intro}>上传和管理你自己写的文章和参考资料。</p>
      <div className={showcase.pane}>{children}</div>
    </div>
  );
}

export type ChatTurn =
  | { role: 'user'; text: string }
  | { role: 'coach'; text: readonly string[]; extra?: ReactNode }
  | { role: 'marker'; text: string };

/**
 * The product's work chat (runtime-work.module.css: head, transcript, date marker, user bubble, coach message with its
 * own head and reply text), in region 3's window frame; each turn arrives a beat after the one before. `meta` sits in
 * the head next to the account.
 */
export function ChatWindowL({ turns, meta }: { turns: readonly ChatTurn[]; meta?: ReactNode }) {
  return (
    <div className={styles.workWindow} inert aria-hidden="true">
      <header className={work.workHead}>
        <div className={work.workTitle}><p className={styles.workTitleText}>{TITLE}</p></div>
        <div className={work.workMeta}><span>{ACCOUNT}</span>{meta}</div>
      </header>
      <section className={work.transcript}>
        {turns.map((turn, index) => (
          <div key={index} className={styles.workTurn} style={{ '--m': index } as CSSProperties}>
            {turn.role === 'marker' ? <p className={work.dateMarker}>{turn.text}</p>
              : turn.role === 'user' ? <p className={work.userMessage}>{turn.text}</p> : (
                <div className={work.agentMessage}>
                  <div className={work.agentIdentity}><img src="/graylum-logo.png" alt="" /><span>Graylum · AI 自媒体陪跑教练</span></div>
                  <div className={work.reply}>{turn.text.map(line => <p key={line} className={showcase.para}>{line}</p>)}</div>
                  {turn.extra}
                </div>
              )}
          </div>
        ))}
      </section>
    </div>
  );
}

/**
 * The files a reply drew on, under the coach's message. The product has no such line yet: it is drawn with the
 * message box's own library-reference chip (work-composer.module.css `.library-reference`), so it reads as the same
 * thing the person picks with `@`.
 */
export function SourcesL({ label, items }: { label: string; items: readonly string[] }) {
  return (
    <p className={showcase.sources}>
      <span>{label}</span>
      {items.map(item => <span key={item} className={showcase.chip}>{item}</span>)}
    </p>
  );
}
