/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import work from '@/app/runtime/runtime-work.module.css';
import { RuntimeProposal, RuntimeReply, RuntimeTurnView } from '@/components/chat-display/runtime-messages';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import compare from '@/components/landing/preview-j/compare-j.module.css';
import { ResearchCallList } from '@/components/research/research-call-list';
import type { ResearchCall } from '@/components/research/research-model';
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import type { WorkflowTurn } from '@/lib/landing/landing-copy-l-workflows';
import { cn } from '@/lib/utils';
import styles from './scenarios-l.module.css';
import { TypingFrame, useStickToEnd, useTyped } from './typing-l';

type Task = { question: string; generic: readonly string[]; genericNote: string; coachNote: string; verdict: string };

/** How many beats a conversation plays in: per turn its message, the library read, each fetch and the reply. */
export function workflowBeats(turns: readonly WorkflowTurn[]) {
  return turns.reduce((sum, turn) => sum + 2 + (turn.read ? 1 : 0) + (turn.calls?.length ?? 0), 0);
}

/**
 * One scenario of region 6, round five (Owner 2026-10-17): the general AI's usual one-shot answer beside the coach's
 * whole work conversation, played beat by beat (`beat`; Infinity shows it all). The coach's side is the product's own
 * work-chat display components (RuntimeTurnView, RuntimeReply, RuntimeProposal), its work shown as the product shows
 * it: a status line for the library read (ChatNoticeList) and the search record, each fetch running, then done
 * (ResearchCallList). The general AI side stays sample J's typical answer. Not a product window as a whole: the coach
 * window carries 示意. A picture: inert; the verdict under both says the point.
 */
export function WorkflowCompareL({ task, turns, beat, badge }: { task: Task; turns: readonly WorkflowTurn[]; beat: number; badge: string }) {
  const log = useRef<HTMLDivElement>(null);
  // The chat follows the newest line until the visitor scrolls it; a new scenario follows again.
  const [follow, setFollow] = useState(true);
  useEffect(() => setFollow(true), [task]);
  useLayoutEffect(() => { if (follow && log.current) log.current.scrollTop = log.current.scrollHeight; }, [beat, follow]);
  useStickToEnd(log, follow);
  const takeOver = () => setFollow(false);
  let at = 0;
  const shown = turns.map(turn => {
    const start = at;
    at += 2 + (turn.read ? 1 : 0) + (turn.calls?.length ?? 0);
    return { turn, start };
  }).filter(({ start }) => beat >= start);
  return (
    <div className={cn(compare.board, styles.board)}>
      <div className={compare.heads} aria-hidden="true">
        <p className={compare.bar} data-generic="">
          <span className={compare.dots}><i /><i /><i /></span><Bot size={14} /><span>{J_COMPARE.genericName}</span>
        </p>
        <p className={compare.bar}><span className={compare.dots}><i /><i /><i /></span><img src="/graylum-logo.png" alt="" />
          <span>{J_COMPARE.coachName}</span><i className={compare.badge}>{badge}</i></p>
      </div>
      <ol className={cn(compare.pairs, styles.pairs)}>
        <li className={cn(compare.pair, styles.pair)} data-in="">
          <div className={compare.cell} data-side="generic">
            <div inert aria-hidden="true">
              <p className={compare.mobileName}><Bot size={13} />{J_COMPARE.genericName}</p>
              <p className={cn(compare.question, styles.genericQuestion)}><span>你</span>{task.question}</p>
              <div className={cn(compare.genericReply, styles.genericReply)}>{task.generic.join('\n')}</div>
            </div>
            <p className={compare.note} data-side="generic"><b>{J_COMPARE.genericNoteLabel}</b>{task.genericNote}</p>
          </div>
          <div className={cn(compare.cell, styles.coach)} data-side="coach">
            <p className={compare.mobileName} aria-hidden="true"><img src="/graylum-logo.png" alt="" />{J_COMPARE.coachName}
              <i className={compare.badge}>{badge}</i></p>
            <div className={cn(work.conversation, styles.conversation)}>
              {/* The scroll is the visitor's to use (round six, S14); what it holds is a picture (inert). */}
              <div ref={log} className={styles.log} onWheel={takeOver} onTouchMove={takeOver} onPointerDown={takeOver}>
                <div className={work.transcript} inert aria-hidden="true">
                  {shown.map(({ turn, start }) => <Turn key={turn.user} turn={turn} local={beat - start} />)}
                </div>
              </div>
            </div>
            <p className={compare.note} data-side="coach"><b>{J_COMPARE.coachNoteLabel}</b>{task.coachNote}</p>
          </div>
          <p className={compare.verdict} data-centred="">{task.verdict}</p>
        </li>
      </ol>
    </div>
  );
}

/** One turn at `local` beats in: its message, then the library read, each fetch (running, then done), then the reply. */
function Turn({ turn, local }: { turn: WorkflowTurn; local: number }) {
  const readAt = turn.read ? 1 : 0;
  const callsFrom = 1 + readAt;
  const replyAt = callsFrom + (turn.calls?.length ?? 0);
  const calls: ResearchCall[] = (turn.calls ?? []).flatMap((call, index) => {
    const at = callsFrom + index;
    if (local < at) return [];
    const done = local > at;
    return [{
      callId: call.query, toolName: call.toolName, args: {}, platform: call.platform ?? 'tiktok', dataKind: call.dataKind,
      query: done && call.found ? `${call.query}：${call.found}` : call.query, state: done ? 'succeeded' : 'running',
    } as ResearchCall];
  });
  const [readingLabel, readLabel] = turn.readLabel ?? ['正在读取资料库', '已读取资料库'];
  const reading = turn.read && local >= readAt
    ? [{ id: 'read', tone: 'status' as const, busy: local === readAt,
      text: `${local === readAt ? readingLabel : readLabel}：${turn.read.join('、')}` }]
    : [];
  const replied = local >= replyAt;
  return (
    <RuntimeTurnView userText={turn.user} completed={replied && Boolean(turn.proposal)}>
      {reading.length ? <ChatNoticeList notices={reading} /> : null}
      {calls.length ? <ResearchCallList calls={calls} /> : null}
      {/* Round seven (T8): the reply typed out live; once the conversation has moved on, whole. */}
      {replied ? <TurnReply reply={turn.reply} proposal={turn.proposal} whole={local > replyAt} /> : null}
    </RuntimeTurnView>
  );
}

/** The coach's reply typed out, then its 建议稿 (if any). */
function TurnReply({ reply, proposal, whole }: { reply: string; proposal?: string; whole: boolean }) {
  const first = useTyped(reply, { whole });
  const second = useTyped(proposal && !first.typing ? proposal : '', { whole });
  return (
    <>
      <TypingFrame typing={first.typing}><RuntimeReply text={first.shown} streaming={first.typing} /></TypingFrame>
      {proposal && !first.typing ? (
        <TypingFrame typing={second.typing}><RuntimeProposal adopted={false} text={second.shown} /></TypingFrame>
      ) : null}
    </>
  );
}
