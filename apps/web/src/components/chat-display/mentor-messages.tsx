/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode, Ref, UIEventHandler } from "react";
import { ChatPendingStatus } from "@/components/chat/ChatInlineNotice";
import resultStyles from "@/components/opc/positioning-result.module.css";
import { MentorMarkdown } from "@/app/positioning/[draftId]/MentorMarkdown";
import { DisplayHeading } from './display-heading';

/**
 * Display-only message list of the positioning mentor chat. Every piece takes ready-made text
 * and callbacks; deciding what a turn shows stays with the page (`mentorReplyDisplay` and friends).
 */

/** "全程同一对话" heading above the message list. */
export function MentorChatHeading() {
  return (
    <div>
      <p className="text-xs text-[var(--text-secondary)]">全程同一对话</p>
      <DisplayHeading as="h3" className="font-semibold">和 AI 教练一起聊，每一步核对确认一次</DisplayHeading>
    </div>
  );
}

/** Scrollable message log; the page passes its scroll-follow ref and handler. */
export function MentorChatLog({ logRef, onScroll, children }: {
  logRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div ref={logRef} onScroll={onScroll} role="log" aria-label="完整 AI 教练消息" aria-live="polite" tabIndex={0}
      className="max-h-[55vh] min-h-56 space-y-3 overflow-y-auto overscroll-contain pr-2">
      {children}
    </div>
  );
}

/** The mentor's first words while the chat has no turn yet. */
export function MentorWelcome({ text }: { text: string }) {
  return (
    <div className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
      <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>Graylum · AI 自媒体陪跑教练</span>
      <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
        {text}
      </p>
    </div>
  );
}

/** One stored turn: the user's message (if any), the reply, its notices. */
export function MentorTurnGroup({ executionId, children }: { executionId: string; children: ReactNode }) {
  return <div data-execution-id={executionId} className="space-y-2">{children}</div>;
}

/** A message the user sent. `stepLabel` is " · <step title>" or empty. */
export function MentorUserMessage({ stepLabel, text }: { stepLabel: string; text: string }) {
  return (
    <div data-message-role="user" className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
      <span className="text-xs text-[var(--text-secondary)]">你{stepLabel}</span>
      <p className={`mt-1 whitespace-pre-wrap break-words ${resultStyles.messageBody}`}>
        {text}</p>
    </div>
  );
}

export type MentorReplyKind = "reply" | "opening" | "summary";

/** The mentor's reply bubble. A `summary` is the step summary card; `opening` is the host-started guide. */
export function MentorReply({ kind, stepLabel, text, live = false, result, summaryHint = false }: {
  kind: MentorReplyKind;
  stepLabel: string;
  /** Markdown text of the reply. */
  text: string;
  /** Still streaming. */
  live?: boolean;
  /** Stored result metadata; a stopped cut keeps the streaming look. */
  result?: { stopped?: boolean; completeness?: string };
  /** Shows the line that a summary does not confirm the step. */
  summaryHint?: boolean;
}) {
  const summary = kind === "summary";
  return (
    <div data-message-role="assistant" data-step-summary={summary || undefined}
      aria-label={summary ? "本步小结卡" : undefined}
      className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
      <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>
        {summary ? "本步小结" : kind === "opening" ? "AI 自媒体陪跑教练 · 主动引导" : "AI 自媒体陪跑教练"}{stepLabel}</span>
      <MentorMarkdown className={`mt-1 ${resultStyles.messageBody}`} text={text} live={live} result={result}/>
      {summaryHint &&
        <p className="mt-2 text-xs text-[var(--text-secondary)]">小结不会自动确认这一步；请在下方确认卡核对后再点确认。</p>}
    </div>
  );
}

/** A message sent but not yet listed by the server. */
export function MentorPendingMessage({ requestId, stepTitle, text, sending }: {
  requestId?: string;
  stepTitle?: string;
  text?: string | null;
  sending: boolean;
}) {
  return (
    <div data-message-role="user" data-request-id={requestId} className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
      <span>你 · {stepTitle}</span>
      <p className={`whitespace-pre-wrap ${resultStyles.messageBody}`}>
        {text}</p><ChatPendingStatus sending={sending}/></div>
  );
}

/** A reply streaming before its turn is listed; without text yet it says "正在思考…". */
export function MentorLiveReply({ text }: { text: string }) {
  return (
    <div data-message-role="assistant" aria-label="AI 自媒体陪跑教练正在回复" className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
      <span className={resultStyles.agentIdentity}><img src="/graylum-logo.png" alt=""/>AI 自媒体陪跑教练</span>
      {text ? <MentorMarkdown className={`mt-1 ${resultStyles.messageBody}`} text={text} live/>
        : <p className={`mt-1 ${resultStyles.messageBody}`}>正在思考…</p>}
    </div>
  );
}
