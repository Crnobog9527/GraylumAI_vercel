/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, Loader2, RotateCw } from 'lucide-react';
import work from '@/app/runtime/runtime-work.module.css';
import {
  RuntimeHeader, RuntimeProposal, RuntimeReply, RuntimeResultsSection, RuntimeTurnView, RuntimeTypePendingPanel,
} from '@/components/chat-display/runtime-messages';
import { AsDemo } from '@/components/chat-display/display-heading';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import takeover from '@/components/landing/preview-j/takeover-j.module.css';
import { ContentDraftView } from '@/components/opc/content-draft-view';
import { ResearchCallList } from '@/components/research/research-call-list';
import type { ResearchCall } from '@/components/research/research-model';
import { L_LATER, L_LATER_CHAT as CHAT, L_LATER_FLYWHEEL as FLY, type LaterStage } from '@/lib/landing/landing-copy-l-later';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { USER_CPS } from '@/lib/landing/typing';
import { cn } from '@/lib/utils';
import picture from './picture-l.module.css';
import { ComposerL } from './ComposerL';
import { RailL } from './RailL';
import { DemoTag } from './DemoTag';
import styles from './later-l.module.css';
import { Caret, TypingFrame, useStickToEnd, useTyped, useTypingGate } from './typing-l';
import { CountdownBar, countdownHost, useAutoAdvance } from './use-auto-advance';
import demo from './demo-l.module.css';

/** How long one beat of a stage lasts (milliseconds); when a whole stage moves on is use-auto-advance.tsx's (U11). */
const BEAT_MS = 900;
/**
 * How many beats each stage plays in (round six: everything arrives as in the product, nothing laid out at once). Round
 * seven (T8): what is typed (the person's message in the box, the coach's reply, the table row by row) is typed live, and
 * the next beat waits for it (useTypingGate).
 */
const STAGE_BEATS: Record<string, number> = { topics: 6, cover: 5, material: 8, script: 5, publish: 4, monitor: 4, review: 6 };

const PUBLISHING = '发布中';
const reducedMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
/**
 * Stages already played are remembered only while the page is open (Owner 2026-10-18: a reload, or coming back another
 * day, plays them again). The key the page once kept them under, in this browser, is cleared and never read.
 */
const OLD_PLAYED_KEY = 'graylum-landing-l-later-played';
const forgetOldPlayed = () => { try { window.localStorage.removeItem(OLD_PLAYED_KEY); } catch { /* nothing stored */ } };

/**
 * Region 3's 第二步 and 第三步 (Owner 2026-10-17, round five, R5): each a row of its stages, one shown at a time, moving
 * on by themselves while on screen (no pause button, round seven T7; the pointer does not stop them either, round eight
 * U3; focus holds them), a click picks any. Each stage plays once (round eight, U4: "用户只要看过一次以后……直接给他看
 * 最终结果"): played, it shows finished from then on while the page stays open (a reload plays it again). Step two is
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
  const [beat, setBeat] = useState(0);
  const [played, setPlayed] = useState<readonly string[]>([]);
  const { Provider: TypingScope, busy } = useTypingGate();
  const ref = useRef<HTMLDivElement>(null);
  const base = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node || reducedMotion() || typeof IntersectionObserver === 'undefined') return;
    setMoving(true);
    forgetOldPlayed();
    const observer = new IntersectionObserver(entries => setSeen(entries.some(entry => entry.isIntersecting)), { threshold: 0.35 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const current = stages[Math.min(active, stages.length - 1)];
  const total = current ? STAGE_BEATS[current.id] ?? 4 : 0;
  const replayed = Boolean(current && played.includes(current.id));
  // A stage plays beat by beat while on screen (what is being typed holds the next beat); once whole it is remembered,
  // holds, then the next stage starts, unless focus is on the step. One already played shows finished and just holds.
  const playing = moving && seen && !busy;
  const finished = replayed || beat >= total;
  useEffect(() => {
    if (!moving || !current || !finished || played.includes(current.id)) return;
    const next = [...played, current.id];
    setPlayed(next);
  }, [moving, current, finished, played]);
  useEffect(() => {
    if (!playing || finished) return;
    const timer = window.setTimeout(() => setBeat(value => value + 1), BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [playing, beat, finished]);
  // Round eight (U11): whole, it moves on to the next stage by the same rules as region 6 (use-auto-advance.tsx): the
  // pointer anywhere on the demo window holds it, a stage the visitor picked stays until the rules hold.
  const { countdown, hand } = useAutoAdvance({
    on: moving && seen && !held, written: finished && !busy, hasNext: stages.length > 1, part: current?.id,
    next: () => { setActive(index => (index + 1) % stages.length); setBeat(0); },
  });
  const pick = (index: number) => { setActive(index); setBeat(0); };
  if (!current) return null;
  const shownBeat = moving && !replayed ? beat : Infinity;
  return (
    <div ref={ref} role="group" aria-label={step.title} className={styles.step} data-region={step.title.slice(0, 3)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
      <div className={k.wrap}>
        <h3 className={styles.title}>{step.title}</h3>
        <p className={styles.lede}>{step.lede}</p>
        <div className={styles.bar}>
          <div role="tablist" aria-label={L_LATER.label} className={styles.tabs}>
            {stages.map((stage, index) => (
              <button key={stage.id} type="button" role="tab" id={`${base}-${stage.id}`} aria-controls={`${base}-panel`}
                aria-selected={index === active} tabIndex={index === active ? 0 : -1} onClick={() => pick(index)} className={countdownHost}>
                <span aria-hidden="true">{index + 1}</span>{stage.label}
                {index === (active + 1) % stages.length ? <CountdownBar share={countdown} /> : null}
              </button>
            ))}
          </div>
        </div>
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${current.id}`} className={styles.panel} key={current.id}>
          <p className={styles.note}><DemoTag />{current.note}</p>
          <div className={styles.picture} {...hand}>
            <TypingScope><AsDemo><StagePicture id={current.id} beat={shownBeat} live={moving && seen} /></AsDemo></TypingScope>
          </div>
        </div>
        <CtaK />
      </div>
    </div>
  );
}

function StagePicture({ id, beat, live }: { id: string; beat: number; live: boolean }) {
  if (id === 'publish' || id === 'monitor' || id === 'review') return <FlywheelPicture id={id} beat={beat} />;
  return <WorkChatPicture id={id} beat={beat} live={live} />;
}

/** A fetch as the product's search record: running, then done (with what came back, when said). */
const call = (query: string, dataKind: string, toolName: string, done: boolean, found?: string) => ({
  callId: query, toolName, args: {}, query: done && found ? `${query}：${found}` : query, platform: 'tiktok', dataKind,
  state: done ? 'succeeded' : 'running',
}) as ResearchCall;
/** A status line as the product shows it: in progress, then done. */
const notice = (id: string, text: string, busy: boolean) => ({ id, tone: 'status' as const, busy, text });
/** The library read: in progress, then done. */
const readNotice = (files: readonly string[], done: boolean) => [notice('read', `${done ? '已读取资料库' : '正在读取资料库'}：${files.join('、')}`, !done)];
/** The title and cover reply (round nine, V2): ten titles with their hooks, ten covers, the pick. */
const COVER_REPLY = '先给 10 个标题，每个标了用的什么钩子（数据为示意）：\n\n| # | 标题 | 钩子 |\n|---|---|---|\n'
  + CHAT.cover.titles.map(([title, hook], index) => `| ${index + 1} | ${title} | ${hook} |`).join('\n')
  + '\n\n再给 10 种封面做法：\n\n| # | 封面画面 | 适合 |\n|---|---|---|\n'
  + CHAT.cover.covers.map(([cover, fits], index) => `| ${index + 1} | ${cover} | ${fits} |`).join('\n')
  + `\n\n${CHAT.cover.pick}`;
const SHOTS = `| ${CHAT.script.shotHead.join(' | ')} |\n|${CHAT.script.shotHead.map(() => '---').join('|')}|\n`;
const STORYBOARD = CHAT.script.shots.map(([n, size, frame, , time]) => `镜头 ${n}（${size}）：${frame} · ${time}`).join('\n');
/** What the person types into the message box before each stage's turn is sent (round seven, T8). */
const ASKS: Record<string, string> = { topics: CHAT.topics.user, cover: CHAT.cover.user, material: CHAT.material.user, script: CHAT.script.user };

/** A coach reply typed out live, with its caret. */
function StreamedReply({ text, whole }: { text: string; whole: boolean }) {
  const { shown, typing } = useTyped(text, { whole });
  return <TypingFrame typing={typing}><RuntimeReply text={shown} streaming={typing} /></TypingFrame>;
}

/** The storyboard table: its head at once, then row by row, each row's words typed. */
function StreamedShots({ whole }: { whole: boolean }) {
  const body = CHAT.script.shots.map(shot => `| ${shot.join(' | ')} |`).join('\n') + `\n\n${CHAT.script.total}`;
  const { shown, typing } = useTyped(body, { whole });
  return <TypingFrame typing={typing}><RuntimeReply text={SHOTS + shown} streaming={typing} /></TypingFrame>;
}

/**
 * Step two in the work conversation (round six: as in the product, everything arrives: the message sent, the library
 * being read, each fetch running then done, the reply written out): the product's header, turns, replies, 建议稿, its
 * message box and the right column, played by `beat`.
 */
function WorkChatPicture({ id, beat, live }: { id: string; beat: number; live: boolean }) {
  const script = id === 'script';
  const chat = useRef<HTMLDivElement>(null);
  // It follows the newest line until the visitor scrolls it themselves; a new stage follows again.
  const [follow, setFollow] = useState(true);
  useEffect(() => setFollow(true), [id]);
  useLayoutEffect(() => { if (follow && chat.current) chat.current.scrollTop = chat.current.scrollHeight; });
  useStickToEnd(chat, follow);
  const takeOver = () => setFollow(false);
  const still = beat === Infinity;
  // The person's message is typed into the box first; once sent, the turn shows.
  // It starts once the step is on screen.
  const ask = useTyped(live || still ? ASKS[id] ?? '' : '', { whole: still, cps: USER_CPS });
  const sent = (live || still) && !ask.typing;
  const proposal = useTyped(script && beat >= 3 ? CHAT.script.proposal : '', { whole: still });
  return (
    <div className={takeover.app}>
      <RailL published />
      <section className={picture.column}>
        {/* The scroll is the visitor's to use; what it holds is a picture (inert). */}
        <div ref={chat} className={cn(styles.chat, demo.scrollbar)} onWheel={takeOver} onTouchMove={takeOver} onPointerDown={takeOver}>
          <div inert>
            <RuntimeHeader headingLevel="h2" title={CHAT.title} meta={{ platform: CHAT.platform, account: CHAT.account, infoHref: '#' }} />
            <div className={work.conversation}>
              <div className={work.transcript}>
                {id === 'topics' && sent ? <TopicsTurn beat={beat} /> : null}
                {id === 'cover' && sent ? <CoverTurn beat={beat} /> : null}
                {id === 'material' && sent ? <MaterialTurn beat={beat} /> : null}
                {script && sent ? (
                  <RuntimeTurnView userText={CHAT.script.user} completed={beat >= 4}>
                    {beat >= 1 ? <StreamedReply text={CHAT.script.reply} whole={still} /> : null}
                    {beat >= 2 ? <StreamedShots whole={still} /> : null}
                    {beat >= 3 ? <TypingFrame typing={proposal.typing}><RuntimeProposal adopted={false} text={proposal.shown} /></TypingFrame> : null}
                  </RuntimeTurnView>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        <div className={styles.composer} inert>
          <ComposerL paragraphs={[[ask.typing ? ask.shown : '']]} caret={ask.typing ? <Caret /> : undefined} />
        </div>
      </section>
      {/* The right column scrolls too, its scrollbar shown (round eight, U11); what it holds is a picture (inert). */}
      <aside className={takeover.checklist}><div className={cn(styles.sideScroll, demo.scrollbar)}><div inert>
        {script && beat >= 3 ? (
          <ContentDraftView platform={CHAT.platform} account={CHAT.account} contentLabel="口播稿" title={CHAT.script.draftTitle}
            body={proposal.shown} versionLine={CHAT.script.versionLine}>
            <RuntimeResultsSection isVideo libraryHref="#" currentScriptId="script-1" versions={[
              { id: 'board-1', kind: 'storyboard', version: 1, status: 'draft', body: STORYBOARD, sourceContentId: 'script-1' },
              { id: 'edit-1', kind: 'editing', version: 1, status: 'draft', body: CHAT.script.editing, sourceContentId: 'script-1' },
            ]} />
          </ContentDraftView>
        ) : (id === 'cover' && beat >= 4) || id === 'material' ? (
          <ContentDraftView platform={CHAT.platform} account={CHAT.account} contentLabel={CHAT.cover.chosenLabel}
            title={CHAT.cover.chosenTitle} body={CHAT.cover.chosenBody} versionLine={CHAT.cover.chosenLine} />
        ) : <RuntimeTypePendingPanel />}
      </div></div></aside>
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
      {beat >= 5 ? <StreamedReply text={CHAT.topics.reply} whole={beat === Infinity} /> : null}
    </RuntimeTurnView>
  );
}

/** Title and cover (round nine, V2): the report read, last week's three fetched, then the lists and the pick. */
function CoverTurn({ beat }: { beat: number }) {
  const { read, call: fetch } = CHAT.cover;
  return (
    <RuntimeTurnView userText={CHAT.cover.user}>
      {beat >= 1 ? <ChatNoticeList notices={readNotice(read, beat >= 2)} /> : null}
      {beat >= 2 ? <ResearchCallList calls={[call(fetch.query, 'account_posts', 'social_account', beat >= 3, fetch.found)]} /> : null}
      {beat >= 4 ? <StreamedReply text={COVER_REPLY} whole={beat === Infinity} /> : null}
    </RuntimeTurnView>
  );
}

/**
 * The material and the voice (round nine, V2: the two former stages in one, half their room): the library searched,
 * the notes found and read, the voice profile loaded; one paragraph; the profile's four lines and the side-by-side
 * (the profile drawn from MASTER_PLAN §5, VOICE not built yet).
 */
function MaterialTurn({ beat }: { beat: number }) {
  const m = CHAT.material;
  const voice = CHAT.voice;
  const notices = [
    ...(beat >= 1 ? [notice('search', beat >= 2 ? `已找到：《${m.document}》` : `正在搜索资料库：${m.search}`, beat < 2)] : []),
    ...(beat >= 2 ? readNotice([`《${m.document}》`], beat >= 3) : []),
    ...(beat >= 3 ? [notice('voice', `已加载${m.voice}`, false)] : []),
  ];
  return (
    <>
      <RuntimeTurnView userText={m.user}>
        {notices.length ? <ChatNoticeList notices={notices} /> : null}
        {beat >= 4 ? <StreamedReply text={m.reply} whole={beat === Infinity} /> : null}
      </RuntimeTurnView>
      {beat >= 5 ? (
        <div className={styles.voice}>
          <section className={styles.card}>
            <header><b>{voice.profileTitle}</b><span>{voice.status}</span></header>
            <dl>{voice.fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
          </section>
          {beat >= 6 ? (
            <section className={styles.card}>
              <header><b>{voice.compareTitle}</b></header>
              <div className={styles.side}>
                <figure><figcaption>{voice.original.label}</figcaption><p>{voice.original.text}</p></figure>
                {beat >= 7 ? (
                  <figure data-new=""><figcaption>{voice.draft.label}</figcaption>
                    <TypedLine text={voice.draft.text} whole={beat === Infinity} /></figure>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Step three, drawn from PUBLISH-MONITOR.md §1 and §5 (not built yet; kept as the placeholder, round six), arriving beat by beat. */
function FlywheelPicture({ id, beat }: { id: string; beat: number }) {
  if (id === 'publish') {
    const p = FLY.publish;
    return (
      <section className={cn(styles.sheet, demo.scrollbar)}>
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
      <section className={cn(styles.sheet, demo.scrollbar)}>
        <header><b>{m.title}</b><span>{m.updated}</span></header>
        <p className={styles.small}>{m.connect}</p>
        {/* Round twelve (D3): a card per platform, each with only the fields its connection gives, arriving one by one. */}
        <ul className={styles.metricCards}>
          {m.cards.slice(0, Math.min(m.cards.length, beat + 1)).map(card => (
            <li key={card.platform}>
              <p className={styles.metricHead}><b>{card.platform}</b>{card.account ? <span>{card.account}</span> : null}</p>
              <dl>{card.fields.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
            </li>
          ))}
        </ul>
        {beat >= 3 ? (
          <div className={styles.insights}>
            <b>{m.insightTitle}</b>
            <ul>{m.insights.map(line => <li key={line}>{line}</li>)}</ul>
          </div>
        ) : null}
      </section>
    );
  }
  const r = FLY.review;
  return (
    <section className={cn(styles.sheet, demo.scrollbar)}>
      <header><b>{r.title}</b><span className={styles.notice}>{r.notice}</span></header>
      <p className={styles.small}>{r.compare}</p>
      <ul className={styles.review}>
        {r.rows.slice(0, Math.min(r.rows.length, beat + 1)).map(([name, result, verdict]) => (
          <li key={name}><b>{name}</b><span>{result}</span><em data-verdict={verdict}>{verdict}</em></li>
        ))}
      </ul>
      {beat >= 3 ? <TypedLine className={styles.why} text={r.why} whole={beat === Infinity} /> : null}
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

/** A plain line typed out live, with its caret. */
function TypedLine({ text, whole, className }: { text: string; whole: boolean; className?: string }) {
  const { shown, typing } = useTyped(text, { whole });
  return <p className={className}>{shown}{typing ? <Caret /> : null}</p>;
}
