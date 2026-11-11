/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, type ReactNode } from 'react';
import { Check, Loader2, RotateCw } from 'lucide-react';
import work from '@/app/(zh-hans)/app/runtime/runtime-work.module.css';
import { RuntimeProposal, RuntimeReply, RuntimeTurnView } from '@/components/chat-display/runtime-messages';
import { ChatNoticeList } from '@/components/chat/ChatInlineNotice';
import { CtaK } from '@/components/landing/preview-k/CtaK';
import k from '@/components/landing/preview-k/k.module.css';
import { ResearchCallList } from '@/components/research/research-call-list';
import type { ResearchCall } from '@/components/research/research-model';
import { L_FLOW_LATER as FLOW } from '@/lib/landing/landing-copy-l-flow';
import { L_LATER, L_LATER_CHAT as CHAT, L_LATER_FLYWHEEL as FLY, type LaterStage } from '@/lib/landing/landing-copy-l-later';
import { allOn, type LandingFlags } from '@/lib/landing/landing-flags';
import { cn } from '@/lib/utils';
import { arrivedAt, cuesAt, loopMs, typedAt, typeMs, type Cue, type CueList } from '@/lib/landing/loop-timeline';
import { Arrive, Feed, FlowModuleL, FlowStepL, type FlowPicture } from './FlowModuleL';
import flow from './flow-l.module.css';
import styles from './later-l.module.css';
import { TypingFrame } from './typing-l';

const PUBLISHING = '发布中';
/** Tables are written several times faster than sentences: they are looked at, not read along. */
const TABLE_CPS = 420;
/**
 * The stages once played were remembered in this browser; since 2026-10-18 nothing is (and since 2026-11-11 every
 * module simply plays in a loop). The key the page once kept them under is cleared and never read.
 */
const OLD_PLAYED_KEY = 'graylum-landing-l-later-played';
const forgetOldPlayed = () => { try { window.localStorage.removeItem(OLD_PLAYED_KEY); } catch { /* nothing stored */ } };

/**
 * Region 3's 第二步 and 第三步 (Owner 2026-10-17, round five, R5). Owner 2026-11-11: each stage is a module of its own
 * (FlowModuleL), a name, one line and a short picture that plays by itself in a loop, in place of the row of tabs with
 * one long demo at a time. Step two's pictures are the work conversation's own pieces (chat-display's turn, replies and
 * 建议稿, the search record, the status lines), a few seconds of each stage: what is asked, what the coach does, what
 * comes back. The voice profile and all of step three (publishing, monitoring, the weekly review) are drawn from the
 * plan because the product has not built them yet (L_LATER marks which). The page is the full launched version (Owner
 * 2026-10-17): every stage shows.
 */
export function LaterStepsL({ flags }: { flags: LandingFlags }) {
  useEffect(forgetOldPlayed, []);
  return (
    <>
      <LaterStep step={L_LATER.two} flags={flags} />
      <LaterStep step={L_LATER.three} flags={flags} />
    </>
  );
}

function LaterStep({ step, flags }: { step: { title: string; lede: string; stages: readonly LaterStage[] }; flags: LandingFlags }) {
  const stages = step.stages.filter(stage => allOn(flags, stage.needs) && PICTURES[stage.id]);
  if (!stages.length) return null;
  return (
    <div className={k.wrap}>
      <FlowStepL title={step.title} lede={step.lede} after={<div className={styles.after}><CtaK /></div>}>
        {stages.map((stage, index) => (
          <FlowModuleL key={stage.id} number={index + 1} name={stage.label} line={stage.note} picture={PICTURES[stage.id]} />
        ))}
      </FlowStepL>
    </div>
  );
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

/** The work conversation's one turn, as the product draws it. */
function Turn({ ask, completed, children }: { ask: string; completed?: boolean; children: ReactNode }) {
  return (
    <Feed>
      <div className={cn(work.conversation, flow.work)}>
        <div className={work.transcript}><RuntimeTurnView userText={ask} completed={completed}>{children}</RuntimeTurnView></div>
      </div>
    </Feed>
  );
}
/** A coach reply being written. */
function Reply({ text, cue, cps }: { text: string; cue: Cue; cps?: number }) {
  if (!cue.on) return null;
  return <TypingFrame typing={!cue.done}><RuntimeReply text={typedAt(text, cue, cps)} streaming={!cue.done} /></TypingFrame>;
}

/* 选题: the library read, last week's posts and the benchmarks fetched, the three topics. */
const TOPICS_CUES = [['ask', 600], ['read', 800], ['mine', 800], ['others', 800], ['reply', typeMs(CHAT.topics.reply)]] as const satisfies CueList<string>;
function TopicsPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(TOPICS_CUES, ms);
  const [mine, others] = CHAT.topics.calls;
  const calls = [
    ...(at.mine.on ? [call(mine.query, mine.dataKind, mine.toolName, at.mine.done)] : []),
    ...(at.others.on ? [call(others.query, others.dataKind, others.toolName, at.others.done)] : []),
  ];
  return (
    <Turn ask={CHAT.topics.user} completed={at.reply.done}>
      {at.read.on ? <ChatNoticeList notices={readNotice(CHAT.topics.read, at.read.done)} /> : null}
      {calls.length ? <ResearchCallList calls={calls} /> : null}
      <Reply text={CHAT.topics.reply} cue={at.reply} />
    </Turn>
  );
}

/* 标题和封面: last week's three fetched, the ten titles with their hooks, the ten covers, the coach's pick. */
const table = (head: readonly string[], rows: readonly (readonly string[])[]) =>
  `| # | ${head.join(' | ')} |\n|---|${head.map(() => '---').join('|')}|\n${rows.map((row, index) => `| ${index + 1} | ${row.join(' | ')} |`).join('\n')}`;
const COVER_TABLES = `${FLOW.coverLead}\n\n${table(['标题', '钩子'], CHAT.cover.titles)}\n\n${FLOW.coverSecond}\n\n${table(['封面画面', '适合'], CHAT.cover.covers)}`;
const COVER_CUES = [
  ['ask', 600], ['read', 700], ['fetch', 800], ['tables', typeMs(COVER_TABLES, TABLE_CPS)], ['pick', typeMs(FLOW.coverPick)],
] as const satisfies CueList<string>;
function CoverPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(COVER_CUES, ms);
  const { read, call: fetch } = CHAT.cover;
  return (
    <Turn ask={CHAT.cover.user} completed={at.pick.done}>
      {at.read.on ? <ChatNoticeList notices={readNotice(read, at.read.done)} /> : null}
      {at.fetch.on ? <ResearchCallList calls={[call(fetch.query, 'account_posts', 'social_account', at.fetch.done, fetch.found)]} /> : null}
      <Reply text={COVER_TABLES} cue={at.tables} cps={TABLE_CPS} />
      <Reply text={FLOW.coverPick} cue={at.pick} />
    </Turn>
  );
}

/* 资料库和写作风格: the library searched, the notes found and read, the voice profile loaded and shown. */
const MATERIAL_CUES = [['ask', 600], ['search', 900], ['read', 800], ['voice', 700], ['profile', 1300]] as const satisfies CueList<string>;
function MaterialPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(MATERIAL_CUES, ms);
  const m = CHAT.material;
  const voice = CHAT.voice;
  const notices = [
    ...(at.search.on ? [notice('search', at.search.done ? `已找到：《${m.document}》` : `正在搜索资料库：${m.search}`, !at.search.done)] : []),
    ...(at.read.on ? readNotice([`《${m.document}》`], at.read.done) : []),
    ...(at.voice.on ? [notice('voice', `已加载${m.voice}`, false)] : []),
  ];
  return (
    <Turn ask={m.user}>
      {notices.length ? <ChatNoticeList notices={notices} /> : null}
      <Arrive when={at.profile.on} className={styles.voice}>
        <section className={styles.card}>
          <header><b>{voice.profileTitle}</b><span>{voice.status}</span></header>
          <dl>
            {voice.fields.slice(0, arrivedAt(voice.fields.length, at.profile)).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
      </Arrive>
    </Turn>
  );
}

/* 口播稿和分镜: the script's opening as the product's 建议稿, then the storyboard shot by shot. */
const SCRIPT_OPENING = CHAT.script.proposal.split('\n\n').slice(0, FLOW.scriptParagraphs).join('\n\n');
const SCRIPT_CUES = [['ask', 600], ['script', typeMs(SCRIPT_OPENING)], ['shots', 2400], ['total', 500]] as const satisfies CueList<string>;
function ScriptPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(SCRIPT_CUES, ms);
  const { shots, shotHead, total } = CHAT.script;
  return (
    <Turn ask={CHAT.script.user} completed={at.total.done}>
      {at.script.on ? <TypingFrame typing={!at.script.done}><RuntimeProposal adopted={false} text={typedAt(SCRIPT_OPENING, at.script)} /></TypingFrame> : null}
      {at.shots.on ? (
        <table className={flow.shots}>
          <thead><tr>{FLOW.shotColumns.map(column => <th key={column} scope="col">{shotHead[column]}</th>)}</tr></thead>
          <tbody>
            {shots.slice(0, arrivedAt(shots.length, at.shots)).map(shot => (
              <tr key={shot[0]}>{FLOW.shotColumns.map(column => <td key={column}>{shot[column]}</td>)}</tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {at.total.on ? <p className={flow.total}>{total}</p> : null}
    </Turn>
  );
}

/* Step three, drawn from PUBLISH-MONITOR.md §1 and §5 (not built yet; kept as the placeholder, round six). */
const PUBLISH_CUES = [['open', 700], ['send', 2100]] as const satisfies CueList<string>;
function PublishPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(PUBLISH_CUES, ms);
  const p = FLY.publish;
  const sent = at.send.done ? p.platforms.length : at.send.on ? Math.floor(at.send.share * p.platforms.length) : 0;
  return (
    <Feed tone="sheet">
      <section className={styles.sheet}>
        <header><b>{p.title}</b><span>{p.video}</span></header>
        <p className={styles.button} data-on={at.open.on && !at.send.on ? '' : undefined}>{p.action}</p>
        <ul className={styles.platforms}>
          {p.platforms.map(([name, state], index) => {
            const done = index < sent;
            const waiting = !at.send.on;
            const icon = done ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} aria-hidden="true" data-spin={waiting ? undefined : ''} />;
            return <li key={name} data-waiting={waiting || undefined}>{icon}{name}<span>{done ? state : waiting ? '' : PUBLISHING}</span></li>;
          })}
        </ul>
        <p className={styles.small}>{p.note}</p>
      </section>
    </Feed>
  );
}

const MONITOR_CUES = [['cards', 1800], ['insights', 1400]] as const satisfies CueList<string>;
function MonitorPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(MONITOR_CUES, ms);
  const m = FLY.monitor;
  return (
    <Feed tone="sheet">
      <section className={styles.sheet}>
        <header><b>{m.title}</b><span>{m.updated}</span></header>
        {/* A card per platform, arriving one by one, with the first few of the fields its connection gives. */}
        <ul className={styles.metricCards}>
          {m.cards.slice(0, arrivedAt(m.cards.length, at.cards)).map(card => (
            <li key={card.platform} className={flow.arrive}>
              <p className={styles.metricHead}><b>{card.platform}</b>{card.account ? <span>{card.account}</span> : null}</p>
              <dl>{card.fields.slice(0, FLOW.monitorFields).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
            </li>
          ))}
        </ul>
        <Arrive when={at.insights.on} className={styles.insights}>
          <b>{m.insightTitle}</b>
          <ul>{m.insights.slice(0, arrivedAt(m.insights.length, at.insights)).map(line => <li key={line}>{line}</li>)}</ul>
        </Arrive>
      </section>
    </Feed>
  );
}

const REVIEW_CUES = [['rows', 1500], ['why', typeMs(FLY.review.why)], ['next', 1500], ['loop', 700]] as const satisfies CueList<string>;
function ReviewPicture({ ms }: { ms: number | null }) {
  const at = cuesAt(REVIEW_CUES, ms);
  const r = FLY.review;
  return (
    <Feed tone="sheet">
      <section className={styles.sheet}>
        <header><b>{r.title}</b><span className={styles.notice}>{r.notice}</span></header>
        <p className={styles.small}>{r.compare}</p>
        <ul className={styles.review}>
          {r.rows.slice(0, arrivedAt(r.rows.length, at.rows)).map(([name, result, verdict]) => (
            <li key={name} className={flow.arrive}><b>{name}</b><span>{result}</span><em data-verdict={verdict}>{verdict}</em></li>
          ))}
        </ul>
        {at.why.on ? <p className={styles.why}>{typedAt(r.why, at.why)}</p> : null}
        <Arrive when={at.next.on}>
          <p className={styles.small}>{r.nextTitle}</p>
          <ol className={styles.next}>
            {r.next.slice(0, arrivedAt(r.next.length, at.next)).map(item => <li key={item}>{item}<span className={styles.chip}>{r.action}</span></li>)}
          </ol>
        </Arrive>
        <Arrive when={at.loop.on}><p className={styles.loop}><RotateCw size={15} aria-hidden="true" />{r.loop}</p></Arrive>
      </section>
    </Feed>
  );
}

const picture = (cues: CueList<string>, Picture: (props: { ms: number | null }) => ReactNode): FlowPicture =>
  ({ totalMs: loopMs(cues), draw: ms => <Picture ms={ms} /> });

/** The pictures of steps two and three, by stage id (landing-copy-l-later.ts). */
const PICTURES: Record<string, FlowPicture> = {
  topics: picture(TOPICS_CUES, TopicsPicture),
  cover: picture(COVER_CUES, CoverPicture),
  material: picture(MATERIAL_CUES, MaterialPicture),
  script: picture(SCRIPT_CUES, ScriptPicture),
  publish: picture(PUBLISH_CUES, PublishPicture),
  monitor: picture(MONITOR_CUES, MonitorPicture),
  review: picture(REVIEW_CUES, ReviewPicture),
};
