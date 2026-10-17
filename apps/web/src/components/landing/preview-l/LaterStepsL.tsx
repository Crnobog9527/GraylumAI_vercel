/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Loader2, Pause, Play, RotateCw } from 'lucide-react';
import work from '@/app/runtime/runtime-work.module.css';
import {
  RuntimeHeader, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView, RuntimeTypePendingPanel,
} from '@/components/chat-display/runtime-messages';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { RailJ } from '@/components/landing/preview-j/PositioningClipJ';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ContentDraftView } from '@/components/opc/content-draft-view';
import { WorkComposer } from '@/components/opc/work-composer';
import { ResearchCallList } from '@/components/research/research-call-list';
import type { ResearchCall } from '@/components/research/research-model';
import { L_LATER, L_LATER_CHAT as CHAT, L_LATER_FLYWHEEL as FLY, type LaterStage } from '@/lib/landing/landing-copy-l-later';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import picture from './picture-l.module.css';
import { DemoTag } from './DemoTag';
import styles from './later-l.module.css';

/** How long one beat of a stage lasts, and the hold once a stage is whole before the next one (milliseconds). */
const BEAT_MS = 900;
/** Once whole, a stage stays long enough to be read (round six: the script and its 11-shot table at least 15 seconds). */
const HOLD_MS: Record<string, number> = { script: 15000 };
const HOLD_DEFAULT_MS = 6000;
/** How many beats each stage plays in (round six: everything arrives as in the product, nothing laid out at once). */
const STAGE_BEATS: Record<string, number> = { topics: 8, library: 8, voice: 9, script: 12, publish: 4, monitor: 4, review: 6 };
/** The part of `text` written by beat `beat` of `from`..`from + span`: the reply streams in. */
const typed = (text: string, beat: number, from: number, span: number) =>
  beat >= from + span ? text : beat < from ? '' : text.slice(0, Math.round(text.length * (beat - from + 1) / (span + 1)));
const noop = () => undefined;
const PUBLISHING = '发布中';
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
  const [beat, setBeat] = useState(0);
  // The visitor's hand on the picture (pointer over it, scrolling or clicking in it) pauses it, as region 6 does.
  const [touching, setTouching] = useState(false);
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
  const current = stages[Math.min(active, stages.length - 1)];
  const total = current ? STAGE_BEATS[current.id] ?? 4 : 0;
  // A stage plays beat by beat while on screen (the pause button stops it); once whole it holds, then the next stage
  // starts, unless the pointer or focus is on the step.
  const playing = moving && seen && !stopped && !touching;
  useEffect(() => {
    if (!playing) return;
    const whole = beat >= total;
    if (whole && (held || stages.length < 2)) return;
    const timer = window.setTimeout(() => {
      if (!whole) { setBeat(value => value + 1); return; }
      setActive(index => (index + 1) % stages.length); setBeat(0);
    }, whole ? HOLD_MS[current.id] ?? HOLD_DEFAULT_MS : BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [playing, held, beat, total, stages.length, current]);
  const pick = (index: number) => { setActive(index); setBeat(0); };
  if (!current) return null;
  const shownBeat = moving ? beat : Infinity;
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
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)}>
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
          <p className={styles.note}><DemoTag />{current.note}</p>
          <div className={styles.picture} onPointerEnter={() => setTouching(true)} onPointerLeave={() => setTouching(false)}>
            <StagePicture id={current.id} beat={shownBeat} />
          </div>
        </div>
        <CtaK />
      </div>
    </div>
  );
}

function StagePicture({ id, beat }: { id: string; beat: number }) {
  if (id === 'publish' || id === 'monitor' || id === 'review') return <FlywheelPicture id={id} beat={beat} />;
  return <WorkChatPicture id={id} beat={beat} />;
}

const call = (query: string, dataKind: string, toolName: string, done: boolean) => ({
  callId: query, toolName, args: {}, query, platform: 'tiktok', dataKind, state: done ? 'succeeded' : 'running',
}) as ResearchCall;
/** The library read, as the product's status line: in progress, then done. */
const readNotice = (files: readonly string[], done: boolean) =>
  [{ id: 'read', tone: 'status' as const, busy: !done, text: `${done ? CHAT.library.read : CHAT.library.reading}：${files.join('、')}` }];
const SHOTS = `| ${CHAT.script.shotHead.join(' | ')} |\n|${CHAT.script.shotHead.map(() => '---').join('|')}|\n`;
const shotTable = (rows: number) => SHOTS + CHAT.script.shots.slice(0, rows).map(shot => `| ${shot.join(' | ')} |`).join('\n')
  + (rows >= CHAT.script.shots.length ? `\n\n${CHAT.script.total}` : '');
const STORYBOARD = CHAT.script.shots.map(([n, size, frame, , time]) => `镜头 ${n}（${size}）：${frame} · ${time}`).join('\n');
const LIBRARY_ASK = `@${CHAT.library.document} ${CHAT.library.user}`;

/**
 * Step two in the work conversation (round six: as in the product, everything arrives: the message sent, the library
 * being read, each fetch running then done, the reply written out): the product's header, turns, replies, 建议稿, its
 * message box and the right column, played by `beat`.
 */
function WorkChatPicture({ id, beat }: { id: string; beat: number }) {
  const script = id === 'script';
  const chat = useRef<HTMLDivElement>(null);
  // It follows the newest line until the visitor scrolls it themselves; a new stage follows again.
  const [follow, setFollow] = useState(true);
  useEffect(() => setFollow(true), [id]);
  useLayoutEffect(() => { if (follow && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [id, beat, follow]);
  const takeOver = () => setFollow(false);
  const proposal = script ? typed(CHAT.script.proposal, beat, 9, 2) : '';
  const composer = id === 'library' && beat < 2 ? LIBRARY_ASK.slice(0, Math.round(LIBRARY_ASK.length * (beat + 1) / 2)) : '';
  return (
    <div className={takeover.app}>
      <RailJ published launched />
      <section className={picture.column}>
        {/* The scroll is the visitor's to use; what it holds is a picture (inert). */}
        <div ref={chat} className={styles.chat} onWheel={takeOver} onTouchMove={takeOver} onPointerDown={takeOver}>
          <div inert>
            <RuntimeHeader headingLevel="h2" title={CHAT.title} meta={{ platform: CHAT.platform, account: CHAT.account, infoHref: '#' }} />
            <div className={work.conversation}>
              <div className={work.transcript}>
                {id === 'topics' ? <TopicsTurn beat={beat} /> : null}
                {id === 'library' && beat >= 2 ? <LibraryTurn beat={beat - 2} /> : null}
                {id === 'voice' ? <><LibraryTurn beat={Infinity} /><VoicePicture beat={beat} /></> : null}
                {script ? (
                  <RuntimeTurnView userText={CHAT.script.user} completed={beat >= 12}>
                    {beat >= 1 ? <RuntimeReply text={typed(CHAT.script.reply, beat, 1, 1)} /> : null}
                    {beat >= 3 ? <RuntimeReply text={shotTable(Math.min(CHAT.script.shots.length, (beat - 2) * 2))} /> : null}
                    {beat >= 9 ? <RuntimeProposal adopted={false} text={proposal} /> : null}
                  </RuntimeTurnView>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <div className={styles.composer} inert>
          <WorkComposer value={composer} onChange={noop} onSend={noop} label="消息" placeholder="消息" />
        </div>
      </section>
      <aside className={takeover.checklist} inert>
        {script && beat >= 9 ? (
          <ContentDraftView platform={CHAT.platform} account={CHAT.account} contentLabel="口播稿" title={CHAT.script.draftTitle}
            body={proposal} versionLine={CHAT.script.versionLine}>
            <RuntimeResultsSection isVideo libraryHref="#" currentScriptId="script-1" versions={[
              { id: 'board-1', kind: 'storyboard', version: 1, status: 'draft', body: STORYBOARD, sourceContentId: 'script-1' },
              { id: 'edit-1', kind: 'editing', version: 1, status: 'draft', body: CHAT.script.editing, sourceContentId: 'script-1' },
            ]} />
          </ContentDraftView>
        ) : <RuntimeTypePendingPanel />}
      </aside>
    </div>
  );
}

function TopicsTurn({ beat }: { beat: number }) {
  const [first, second] = CHAT.topics.calls;
  const calls = [
    ...(beat >= 2 ? [call(first.query, first.dataKind, first.toolName, beat >= 3)] : []),
    ...(beat >= 3 ? [call(second.query, second.dataKind, second.toolName, beat >= 4)] : []),
  ];
  return (
    <RuntimeTurnView userText={CHAT.topics.user}>
      {beat >= 1 ? <ChatNoticeList notices={readNotice(CHAT.topics.read, beat >= 2)} /> : null}
      {calls.length ? <ResearchCallList calls={calls} /> : null}
      {beat >= 5 ? <RuntimeReply text={typed(CHAT.topics.reply, beat, 5, 2)} /> : null}
    </RuntimeTurnView>
  );
}

/** The library turn (round six, S6): sent with the @ reference; the library is read (in progress, then done); the reply. */
function LibraryTurn({ beat }: { beat: number }) {
  return (
    <RuntimeTurnView userText={LIBRARY_ASK}>
      {beat >= 1 ? <ChatNoticeList notices={readNotice([CHAT.library.document], beat >= 2)} /> : null}
      {beat >= 3 ? <RuntimeReply text={typed(CHAT.library.reply, beat, 3, 2)} /> : null}
    </RuntimeTurnView>
  );
}

/** The voice profile and the side-by-side, drawn from MASTER_PLAN §5 (VOICE is not built yet), filled in beat by beat. */
function VoicePicture({ beat }: { beat: number }) {
  const voice = CHAT.voice;
  return (
    <div className={styles.voice}>
      <section className={styles.card}>
        <header><b>{voice.profileTitle}</b><span>{voice.status}</span></header>
        <dl>
          {voice.fields.slice(0, Math.min(voice.fields.length, beat + 1)).map(([name, value]) => (
            <div key={name}><dt>{name}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        {beat >= 5 ? <p className={styles.toggle}><i aria-hidden="true" />{voice.toggle}</p> : null}
      </section>
      {beat >= 6 ? (
        <section className={styles.card}>
          <header><b>{voice.compareTitle}</b></header>
          <div className={styles.side}>
            <figure><figcaption>{voice.original.label}</figcaption><p>{voice.original.text}</p></figure>
            {beat >= 7 ? <figure data-new=""><figcaption>{voice.draft.label}</figcaption><p>{typed(voice.draft.text, beat, 7, 1)}</p></figure> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** Step three, drawn from PUBLISH-MONITOR.md §1 and §5 (not built yet; kept as the placeholder, round six), arriving beat by beat. */
function FlywheelPicture({ id, beat }: { id: string; beat: number }) {
  if (id === 'publish') {
    const p = FLY.publish;
    return (
      <section className={styles.sheet}>
        <header><b>{p.title}</b><span>{p.video}</span></header>
        <ul className={styles.platforms}>
          {p.platforms.map(([name, state], index) => {
            const done = beat > index;
            const icon = done ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} aria-hidden="true" />;
            return <li key={name}>{icon}{name}<span>{done ? state : PUBLISHING}</span></li>;
          })}
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
            <tbody>{m.rows.slice(0, Math.min(m.rows.length, beat + 1)).map(row => (
              <tr key={row[0]}>{row.map((cell, index) => (index === 0 ? <th key={index} scope="row">{cell}</th>
                : <td key={index} data-missing={/平台不提供|未取到/.test(cell) || undefined}>{cell}</td>))}</tr>
            ))}</tbody>
          </table>
        </div>
        {beat >= 3 ? <p className={styles.small}>{m.footnote}</p> : null}
      </section>
    );
  }
  const r = FLY.review;
  return (
    <section className={styles.sheet}>
      <header><b>{r.title}</b><span className={styles.notice}>{r.notice}</span></header>
      <p className={styles.small}>{r.compare}</p>
      <ul className={styles.review}>
        {r.rows.slice(0, Math.min(r.rows.length, beat + 1)).map(([name, result, verdict]) => (
          <li key={name}><b>{name}</b><span>{result}</span><em data-verdict={verdict}>{verdict}</em></li>
        ))}
      </ul>
      {beat >= 3 ? <p className={styles.why}>{r.why}</p> : null}
      {beat >= 4 ? (
        <>
          <p className={styles.small}>{r.nextTitle}</p>
          <ol className={styles.next}>{r.next.map(item => <li key={item}>{item}<span className={styles.chip}>{r.action}</span></li>)}</ol>
        </>
      ) : null}
      {beat >= 5 ? <p className={styles.loop}><RotateCw size={15} aria-hidden="true" />{r.loop}</p> : null}
    </section>
  );
}
