/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bot } from 'lucide-react';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { ChatPendingStatus } from '@/components/chat/ChatInlineNotice';
import workStyles from '@/app/runtime/runtime-work.module.css';
import { DisplayHeading } from './display-heading';

/**
 * Display-only pieces of the work conversation (/runtime): header, message list, the "建议稿"
 * block and the right-hand results column. Text and flags come in as props; requests, storage
 * and protocol parsing stay with the page.
 */

/** Title row. With `meta` it shows the topic's platform, account and work info; otherwise `action`. */
export function RuntimeHeader({ title, subtitle, meta, action, headingLevel = 'h1' }: {
  title: string;
  /** The title's heading level: the page's own title (h1) by default; a page showing it inside its own content, h2. */
  headingLevel?: 'h1' | 'h2';
  /** Small line under the title (only shown without a topic). */
  subtitle?: string;
  meta?: { platform: string; account: string; infoHref: string; showExpand?: boolean; onExpand?: () => void };
  action?: ReactNode;
}) {
  return (
    <header className={workStyles.workHead}>
      <div className={workStyles.workTitle}><DisplayHeading as={headingLevel}>{title}</DisplayHeading>{subtitle&&<small>{subtitle}</small>}</div>
      {meta?<div className={workStyles.workMeta}><span>{meta.platform} · {meta.account}</span><Link href={meta.infoHref}>工作信息</Link>
        {meta.showExpand&&<button type="button" onClick={meta.onExpand}>展开成果</button>}</div>:action??null}
    </header>
  );
}

/** Shown while the conversation has no turn yet. */
export function RuntimeEmptyState({ text }: { text: string }) {
  return (
    <div className="mx-auto flex min-h-64 max-w-xl flex-col items-center justify-center px-6 py-12 text-center">
      <Bot className="mb-3 h-7 w-7 text-[var(--color-primary)]"/><DisplayHeading as="h2" className="text-base font-medium">开始一段对话</DisplayHeading>
      <p className="mt-2 text-[13px] text-[var(--text-tertiary)]">{text}</p></div>
  );
}

/**
 * One turn: optional date line, the user's message, then the coach's message. `children` is the
 * body of the coach's message (reply, proposal, buttons, notices).
 */
export function RuntimeTurnView({ dateLabel, userText, completed = false, children }: {
  dateLabel?: string | null;
  userText?: string | null;
  /** Shows "已完成本轮建议" next to the coach's name. */
  completed?: boolean;
  children?: ReactNode;
}) {
  return (
    <div>{dateLabel&&<p className={workStyles.dateMarker}>{dateLabel}</p>}<article className={workStyles.turn}>
      {userText!=null&&<p className={workStyles.userMessage}>{userText}</p>}
      <div className={workStyles.agentMessage}><div className={workStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>
        <span>Graylum · AI 自媒体陪跑教练</span>{completed&&<span className="ml-2 text-xs opacity-70">已完成本轮建议</span>}</div><div>
        {children}
      </div></div>
    </article></div>
  );
}

/** A plain reply, or the line that its source is gone. */
export function RuntimeReply({ text, available = true, streaming = false }: {
  text: string;
  available?: boolean;
  /** Still being written: an unfinished Markdown mark is closed for display, as in the mentor chat. */
  streaming?: boolean;
}) {
  return available ? <MessageMarkdown className={workStyles.reply} text={text} streaming={streaming}/>
    : <p className={workStyles.reply}>来源已不可用，暂不展示此内容。</p>;
}

/** The "建议稿" block of a completed Skill reply on a topic. */
export function RuntimeProposal({ adopted, text }: { adopted: boolean; text: string }) {
  return (
    <div className={workStyles.proposal}><div className={workStyles.proposalHead}><strong>建议稿</strong>
      <span>{adopted?'已采用':'尚未采用'}</span></div><RuntimeReply text={text}/></div>
  );
}

/** The user's message right after sending, before the server lists its turn. */
export function RuntimePendingMessage({ text, sending }: { text: string; sending: boolean }) {
  return (
    <article className={workStyles.turn} data-message-role="user"><p className={workStyles.userMessage}>{text}
      <ChatPendingStatus sending={sending}/></p></article>
  );
}

/** Right column before the topic's content type is confirmed. */
export function RuntimeTypePendingPanel() {
  return <div className={workStyles.typePending}><DisplayHeading as="h2">当前成果</DisplayHeading><p>先在对话中确认这条选题的内容类型，再起草和保存稿件。已确认前不会创建内容版本。</p></div>;
}

export type RuntimeResultVersion = { id: string; kind: string; version: number; status: string; body: string | null; sourceContentId: string | null };
export type RuntimeSavedResult = { artifactId: string; version: number; body: string | null };

/** Storyboard / editing versions of a video topic and other saved Skill results, under the draft editor. */
export function RuntimeResultsSection({ isVideo, versions, currentScriptId, saved, libraryHref }: {
  isVideo: boolean;
  /** All content versions of the topic; only storyboard and editing ones are listed. */
  versions: RuntimeResultVersion[];
  currentScriptId?: string;
  saved?: RuntimeSavedResult[];
  libraryHref: string;
}) {
  if (!isVideo && !saved?.length) return null;
  return (
    <section aria-label={isVideo?'视频派生成果':'其他 Skill 成果'} className={workStyles.videoResults}>
      {isVideo&&<><DisplayHeading as="h2">分镜与剪辑建议</DisplayHeading>{versions.filter(version=>version.kind==='storyboard'||version.kind==='editing').map(version=>
        <details key={version.id}><summary>{version.kind==='storyboard'?'分镜':'剪辑建议'} · 第 {version.version} 版 · {version.status==='final'?'已定稿':'草稿'}
          {version.sourceContentId===currentScriptId?' · 匹配当前口播稿':' · 旧口播稿版本'}</summary><p>{version.body}</p></details>)}</>}
      {saved?.map(artifact=><details key={artifact.artifactId}><summary>其他 Skill 成果 · 第 {artifact.version} 版</summary>
        <p>{artifact.body??'来源不可用'}</p></details>)}
      <Link href={libraryHref}>在资料库查看这个选题</Link>
    </section>
  );
}
