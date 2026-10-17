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
import styles from './scenarios-l.module.css';

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
export function WorkflowCompareL({ task, turns, beat, badge, onHold }: {
  task: Task; turns: readonly WorkflowTurn[]; beat: number; badge: string;
  /** The visitor's hand on the coach's chat (pointer over it, or scrolling it): the caller pauses its play (round six, S14). */
  onHold?: (holding: boolean) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  // The chat follows the newest line until the visitor scrolls it; a new scenario follows again.
  const [follow, setFollow] = useState(true);
  useEffect(() => setFollow(true), [task]);
  useLayoutEffect(() => { if (follow && log.current) log.current.scrollTop = log.current.scrollHeight; }, [beat, follow]);
  const takeOver = () => { setFollow(false); onHold?.(true); };
  let at = 0;
  const shown = turns.map(turn => {
    const start = at;
    at += 2 + (turn.read ? 1 : 0) + (turn.calls?.length ?? 0);
    return { turn, start };
  }).filter(({ start }) => beat >= start);
  return (
    <div className={compare.board}>
      <div className={compare.heads} aria-hidden="true">
        <p className={compare.bar} data-generic="">
          <span className={compare.dots}><i /><i /><i /></span><Bot size={14} /><span>{J_COMPARE.genericName}</span>
        </p>
        <p className={compare.bar}><span className={compare.dots}><i /><i /><i /></span><img src="/graylum-logo.png" alt="" />
          <span>{J_COMPARE.coachName}</span><i className={compare.badge}>{badge}</i></p>
      </div>
      <ol className={compare.pairs}>
        <li className={compare.pair} data-in="">
          <div className={compare.cell} data-side="generic">
            <div inert aria-hidden="true">
              <p className={compare.mobileName}><Bot size={13} />{J_COMPARE.genericName}</p>
              <p className={compare.question}><span>你</span>{task.question}</p>
              <div className={compare.genericReply}>{task.generic.join('\n')}</div>
            </div>
            <p className={compare.note} data-side="generic"><b>{J_COMPARE.genericNoteLabel}</b>{task.genericNote}</p>
          </div>
          <div className={compare.cell} data-side="coach">
            <p className={compare.mobileName} aria-hidden="true"><img src="/graylum-logo.png" alt="" />{J_COMPARE.coachName}
              <i className={compare.badge}>{badge}</i></p>
            <div className={work.conversation}>
              {/* The scroll is the visitor's to use (round six, S14); what it holds is a picture (inert). */}
              <div ref={log} className={styles.log} onWheel={takeOver} onTouchMove={takeOver} onPointerDown={takeOver}
                onPointerEnter={() => onHold?.(true)} onPointerLeave={() => onHold?.(false)}>
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
    return [{
      callId: call.query, toolName: call.toolName, args: {}, query: call.query, platform: 'tiktok', dataKind: call.dataKind,
      state: local > at ? 'succeeded' : 'running',
    } as ResearchCall];
  });
  const reading = turn.read && local >= readAt
    ? [{ id: 'read', tone: 'status' as const, busy: local === readAt,
      text: `${local === readAt ? '正在读取资料库' : '已读取资料库'}：${turn.read.join('、')}` }]
    : [];
  const replied = local >= replyAt;
  return (
    <RuntimeTurnView userText={turn.user} completed={replied && Boolean(turn.proposal)}>
      {reading.length ? <ChatNoticeList notices={reading} /> : null}
      {calls.length ? <ResearchCallList calls={calls} /> : null}
      {replied ? <RuntimeReply text={turn.reply} /> : null}
      {replied && turn.proposal ? <RuntimeProposal adopted={false} text={turn.proposal} /> : null}
    </RuntimeTurnView>
  );
}
