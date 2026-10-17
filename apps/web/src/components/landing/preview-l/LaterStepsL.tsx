/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Pause, Play, RotateCw } from 'lucide-react';
import work from '@/app/runtime/runtime-work.module.css';
import {
  RuntimeHeader, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView, RuntimeTypePendingPanel,
} from '@/components/chat-display/runtime-messages';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { RailJ } from '@/components/landing/preview-j/PositioningClipJ';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ContentDraftView } from '@/components/opc/content-draft-view';
import { ResearchCallList } from '@/components/research/research-call-list';
import type { ResearchCall } from '@/components/research/research-model';
import { L_LATER, L_LATER_CHAT as CHAT, L_LATER_FLYWHEEL as FLY, type LaterStage } from '@/lib/landing/landing-copy-l-later';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import picture from './picture-l.module.css';
import styles from './later-l.module.css';

const STAGE_MS = 7000;
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Region 3's 第二步 and 第三步 (Owner 2026-10-17, round five, R5): each a row of its stages, one shown at a time, moving
 * on by themselves while on screen (the pointer or focus holds them; a button pauses), a click picks any. Step two is
 * the work conversation as the product draws it (chat-display's work-chat pieces, the 正文稿件 column, 分镜与剪辑建议);
 * its voice stage, and all of step three (publishing, monitoring, the weekly review), are drawn from the plan because
 * the product has not built them yet (L_LATER marks which). The page is the full launched version (Owner
 * 2026-10-17): every stage shows.
 */
export function LaterStepsL({ flags }: { flags: LandingFlags }) {
  return (
    <>
      <LaterStep step={L_LATER.two} flags={flags} />
      <LaterStep step={L_LATER.three} flags={flags} />
    </>
  );
}

function LaterStep({ step, flags }: { step: { title: string; lede: string; stages: readonly LaterStage[] }; flags: LandingFlags }) {
  const stages = step.stages.filter(stage => allOn(flags, stage.needs));
  const [active, setActive] = useState(0);
  const [seen, setSeen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [held, setHeld] = useState(false);
  const [stopped, setStopped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const base = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setMoving(true);
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const advancing = moving && seen && !held && !stopped && stages.length > 1;
  useEffect(() => {
    if (!advancing) return;
    const timer = window.setTimeout(() => setActive(index => (index + 1) % stages.length), STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [advancing, active, stages.length]);
  const current = stages[Math.min(active, stages.length - 1)];
  if (!current) return null;
  return (
    <div ref={ref} role="group" aria-label={step.title} className={styles.step} data-region={step.title.slice(0, 3)}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={k.wrap}>
        <h3 className={styles.title}>{step.title}</h3>
        <p className={styles.lede}>{step.lede}</p>
        <div className={styles.bar}>
          <div role="tablist" aria-label={L_LATER.label} className={styles.tabs}>
            {stages.map((stage, index) => (
              <button key={stage.id} type="button" role="tab" id={`${base}-${stage.id}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => setActive(index)}>
                <span aria-hidden="true">{index + 1}</span>{stage.label}
              </button>
            ))}
          </div>
          {moving && stages.length > 1 ? (
            <button type="button" className={styles.pause} onClick={() => setStopped(value => !value)}>
              {stopped ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}{stopped ? '继续播放' : '暂停'}
            </button>
          ) : null}
        </div>
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${current.id}`} className={styles.panel} key={current.id}>
          <p className={styles.note}>{current.note}</p>
          <div className={styles.picture}>
            <StagePicture id={current.id} />
            <span className={picture.demo}>{DEMO_LABEL}</span>
          </div>
        </div>
        <CtaK />
      </div>
    </div>
  );
}

function StagePicture({ id }: { id: string }) {
  if (id === 'publish' || id === 'monitor' || id === 'review') return <FlywheelPicture id={id} />;
  return <WorkChatPicture id={id} />;
}

/** Step two in the work conversation: the product's header, turns, replies, 建议稿 and the right column. */
function WorkChatPicture({ id }: { id: string }) {
  const script = id === 'script';
  // The conversation opens at its newest message, as the work chat does.
  const chat = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [id]);
  return (
    <div className={takeover.app}>
      <RailJ published launched />
      <section className={picture.column} inert>
        <div ref={chat} className={styles.chat}>
          <RuntimeHeader headingLevel="h2" title={CHAT.title} meta={{ platform: CHAT.platform, account: CHAT.account, infoHref: '#' }} />
          <div className={work.conversation}>
            <div className={work.transcript}>
              {id === 'topics' ? (
                <RuntimeTurnView userText={CHAT.topics.user}>
                  <ChatNoticeList notices={[{ id: 'read', tone: 'status', text: `已读取资料库：${CHAT.topics.read.join('、')}` }]} />
                  <ResearchCallList calls={CHAT.topics.calls.map(call => ({ ...call, callId: call.query, args: {}, platform: 'tiktok',
                    state: 'succeeded' }) as ResearchCall)} />
                  <RuntimeReply text={CHAT.topics.reply} />
                </RuntimeTurnView>
              ) : null}
              {id === 'library' || id === 'voice' || script ? (
                <RuntimeTurnView userText={`@${CHAT.library.document} ${CHAT.library.user}`}>
                  <ChatNoticeList notices={[{ id: 'read', tone: 'status', text: `已读取资料库：${CHAT.library.document}` }]} />
                  <RuntimeReply text={CHAT.library.reply} />
                </RuntimeTurnView>
              ) : null}
              {id === 'voice' ? <VoicePicture /> : null}
              {script ? (
                <RuntimeTurnView userText={CHAT.script.user} completed>
                  <RuntimeReply text={CHAT.script.reply} />
                  <RuntimeProposal adopted={false} text={CHAT.script.proposal} />
                </RuntimeTurnView>
              ) : null}
            </div>
          </div>
        </div>
      </section>
      <aside className={takeover.checklist} inert>
        {script ? (
          <ContentDraftView platform={CHAT.platform} account={CHAT.account} contentLabel="口播稿" title={CHAT.script.draftTitle}
            body={CHAT.script.proposal} versionLine={CHAT.script.versionLine}>
            <RuntimeResultsSection isVideo libraryHref="#" currentScriptId="script-1" versions={[
              { id: 'board-1', kind: 'storyboard', version: 1, status: 'draft', body: CHAT.script.storyboard, sourceContentId: 'script-1' },
              { id: 'edit-1', kind: 'editing', version: 1, status: 'draft', body: CHAT.script.editing, sourceContentId: 'script-1' },
            ]} />
          </ContentDraftView>
        ) : <RuntimeTypePendingPanel />}
      </aside>
    </div>
  );
}

/** The voice profile and the side-by-side, drawn from MASTER_PLAN §5 (VOICE is not built yet). */
function VoicePicture() {
  const voice = CHAT.voice;
  return (
    <div className={styles.voice}>
      <section className={styles.card}>
        <header><b>{voice.profileTitle}</b><span>{voice.status}</span></header>
        <dl>{voice.fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
        <p className={styles.toggle}><i aria-hidden="true" />{voice.toggle}</p>
      </section>
      <section className={styles.card}>
        <header><b>{voice.compareTitle}</b></header>
        <div className={styles.side}>
          <figure><figcaption>{voice.original.label}</figcaption><p>{voice.original.text}</p></figure>
          <figure data-new=""><figcaption>{voice.draft.label}</figcaption><p>{voice.draft.text}</p></figure>
        </div>
      </section>
    </div>
  );
}

/** Step three, drawn from PUBLISH-MONITOR.md §1 and §5 (not built yet). */
function FlywheelPicture({ id }: { id: string }) {
  if (id === 'publish') {
    const p = FLY.publish;
    return (
      <section className={styles.sheet}>
        <header><b>{p.title}</b><span>{p.video}</span></header>
        <ul className={styles.platforms}>
          {p.platforms.map(([name, state]) => <li key={name}><Check size={15} aria-hidden="true" />{name}<span>{state}</span></li>)}
        </ul>
        <p className={styles.small}>{p.note}</p>
        <p className={styles.button}>{p.action}</p>
      </section>
    );
  }
  if (id === 'monitor') {
    const m = FLY.monitor;
    return (
      <section className={styles.sheet}>
        <header><b>{m.title}</b><span>{m.updated}</span></header>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr>{m.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>{m.rows.map(row => (
              <tr key={row[0]}>{row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th>
                : <td key={index} data-missing={/平台不提供|未取到/.test(cell) || undefined}>{cell}</td>))}</tr>
            ))}</tbody>
          </table>
        </div>
        <p className={styles.small}>{m.footnote}</p>
      </section>
    );
  }
  const r = FLY.review;
  return (
    <section className={styles.sheet}>
      <header><b>{r.title}</b><span className={styles.notice}>{r.notice}</span></header>
      <p className={styles.small}>{r.compare}</p>
      <ul className={styles.review}>
        {r.rows.map(([name, result, verdict]) => <li key={name}><b>{name}</b><span>{result}</span><em data-verdict={verdict}>{verdict}</em></li>)}
      </ul>
      <p className={styles.why}>{r.why}</p>
      <p className={styles.small}>{r.nextTitle}</p>
      <ol className={styles.next}>{r.next.map(item => <li key={item}>{item}<span className={styles.chip}>{r.action}</span></li>)}</ol>
      <p className={styles.loop}><RotateCw size={15} aria-hidden="true" />{r.loop}</p>
    </section>
  );
}
