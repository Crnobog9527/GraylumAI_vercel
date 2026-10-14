/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AlertTriangle, Check, FileText, Loader2, Sparkles } from 'lucide-react';
import { MentorMarkdown } from '@/app/positioning/[draftId]/MentorMarkdown';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { DraftRow } from '@/components/opc/draft-row';
import result from '@/components/opc/positioning-result.module.css';
import { QuestionCardView } from '@/components/opc/question-card';
import frame from '@/components/opc/workspace-frame.module.css';
import { Button } from '@/components/ui/button';
import {
  J_PERSONA, J_PERSONA_DIRECTION, J_PERSONA_KINDS, J_PERSONA_QUESTION, J_QUESTION_HEADING, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import {
  J_BENCHMARK_TABLE, J_PLAN_ROWS, J_REPORT, J_TAKEOVER_MOMENTS, type TakeoverCard, type TakeoverLine,
} from '@/lib/landing/landing-copy-j-takeover';
import { cn } from '@/lib/utils';
import { ConfirmJ, JuryJ, personaInformation, filledUpTo } from './WorkbenchPartsJ';
import styles from './takeover-j.module.css';

const noop = () => undefined;

/** How many of a moment's messages have arrived at `local` (0 → 1): the first at once, the last a little before the end. */
export function arrivedAt(local: number, count: number) {
  return Math.min(count, Math.max(1, Math.floor(local * count * 1.15) + 1));
}

/**
 * The real product's positioning workspace, played by the scroll (Owner 2026-10-15: the product as it is). The
 * workspace sidebar (新对话, the feature links, the draft under 待归类); the workbench (我的定位分析, its own step strip
 * 了解你 / 诊断与平台对标 / 定位与执行方案, the conversation with the product's message heads "AI 自媒体陪跑教练 · 步骤"
 * and "本步小结", the step's confirm area, the footer with 导出已确认资料 and 生成完整报告); the 定位清单 on the right,
 * filled as the messages name their fields. After the three steps, the long report; from the report, the jury.
 */
export function PositioningClipJ({ moment, local }: { moment: number; local: number }) {
  const current = J_TAKEOVER_MOMENTS[moment] ?? J_TAKEOVER_MOMENTS[0];
  const step = current.step;
  const chat = step === 3 ? J_TAKEOVER_MOMENTS[2] : current;
  const lines = step === 3 ? chat.lines : current.lines.slice(0, arrivedAt(local, current.lines.length));
  const shownStep = Math.min(step, 2);
  const done = step === 3 || local >= 0.97;
  const confirmed = step === 3 ? 3 : step + (done ? 1 : 0);
  const filled = filledUpTo(moment, lines);
  const information = personaInformation(filled, confirmed);
  const valid = Object.fromEntries(J_STEPS.map((item, index) => [item.id, index < confirmed]));
  const fetchLocal = step === 3 ? 1 : Math.max(0, local * 3 - 1.4);
  const stepTitle = J_STEPS[shownStep].title;
  return (
    <div className={styles.app}>
      <aside className={cn(frame.rail, styles.rail)} aria-label="工作区导航">
        <span className={frame.newConversation}><img className={frame.newConversationIcon} src="/opc-reference/new-chat.svg" alt="" />新对话</span>
        <nav className={frame.railNav}>
          <span><img className={frame.navIcon} src="/opc-reference/squares-four.svg" alt="" />功能广场</span>
          <span><img className={frame.navIcon} src="/opc-reference/magnifying-glass.svg" alt="" />搜索</span>
          <span><img className={frame.navIcon} src="/opc-reference/books.svg" alt="" />资料库</span>
          <button type="button" disabled><img className={frame.navIcon} src="/opc-reference/calendar-blank.svg" alt="" />发布排期 <small>待接入</small></button>
          <button type="button" disabled><img className={frame.navIcon} src="/opc-reference/chart-bar.svg" alt="" />数据复盘 <small>待接入</small></button>
        </nav>
        <div className={frame.history}>
          <div className={frame.historyHead}><span>平台 · 账号 · 工作</span></div>
          <details open><summary>待归类</summary>
            <DraftRow draft={{ draftId: 'sample', businessName: J_PERSONA.account, state: step === 3 ? 'published' : 'draft' }}
              menuOpen={false} menuPosition={{}} onOpenMenu={noop} onCloseMenu={noop} onDeleteConversation={noop} onDeleteDraft={noop} />
          </details>
        </div>
      </aside>

      <section className={styles.center}>
        <header className={result.positionTop}>
          <p className={styles.appTitle}>我的定位分析</p>
          <div className={result.positionActions}>
            <span className={styles.sample}>{DEMO_LABEL}</span><span>整体规划 · {step === 3 ? '已确认' : '进行中'}</span>
          </div>
        </header>
        <nav aria-label="定位步骤" className={result.phaseStrip} style={{ gridTemplateColumns: `repeat(${J_STEPS.length},minmax(0,1fr))` }}>
          {J_STEPS.map((item, index) => (
            <Button key={item.id} size="sm" variant={index === shownStep ? 'default' : 'outline'} tabIndex={-1}>
              {valid[item.id] ? <><Check size={14} aria-hidden="true" />{item.title}</> : `${index + 1} ${item.title}`}
            </Button>
          ))}
        </nav>
        <div className={styles.log}>
          <div className={styles.logInner}>
            {lines.map((line, index) => (
              <Message key={`${chat.id}-${index}`} line={line} step={stepTitle} fetchLocal={fetchLocal} information={information} />
            ))}
          </div>
        </div>
        <footer className={cn(result.publishBar, styles.footer)}>
          <Button size="sm" variant="outline" tabIndex={-1}>{J_REPORT.export}</Button>
          <Button size="sm" variant={step === 3 ? 'default' : 'outline'} tabIndex={-1} data-on={current.id === 'report' || undefined}>
            {J_REPORT.generate}
          </Button>
        </footer>
      </section>

      <aside className={cn(result.panel, styles.checklist)}>
        <header><h2>定位清单</h2><p>跟着对话自动记录；每一步核对后确认一次</p></header>
        <div className={result.body}>
          <CaptureChecklist steps={J_STEPS} information={information} valid={valid} edits={{}} selectedStepId={J_STEPS[shownStep].id}
            editable manual={false} locked confirmable={() => false} confirmation={() => 'none'} saveState={{}} conflicts={{}}
            resolving={null} onEdit={noop} onComposition={noop} onResolve={noop} onReview={noop} onRecoverConfirmation={noop}
            onKeepConflict={noop} onRetrySave={noop} />
        </div>
      </aside>

      {step === 3 ? <Report writing={current.id === 'report'} local={local} /> : null}
      {current.id === 'jury' ? <JuryJ local={local} /> : null}
    </div>
  );
}

/** The long report over the workbench: its chapter list beside a preview that scrolls through the chapters. */
function Report({ writing, local }: { writing: boolean; local: number }) {
  const count = J_REPORT.chapters.length;
  const reached = writing ? Math.min(count - 1, Math.floor(local * 1.1 * count)) : count - 1;
  return (
    <div className={styles.reportLayer}>
      <section className={styles.report} aria-label={J_REPORT.title}>
        <header>
          <FileText size={16} aria-hidden="true" /><h2>{J_REPORT.title}</h2><span>{J_REPORT.size}</span>
          {writing && reached < count - 1 ? <small><Loader2 size={13} aria-hidden="true" />正在写报告…</small> : null}
        </header>
        <div className={styles.reportBody}>
          <ol className={styles.toc}>
            {J_REPORT.chapters.map((chapter, index) => (
              <li key={chapter.title} data-on={index === reached || undefined} data-done={index < reached || undefined}>{chapter.title}</li>
            ))}
          </ol>
          <div className={styles.preview}>
            <div style={{ translate: `0 calc(${-Math.max(0, reached - 1)} * var(--chapter-step))` }}>
              {J_REPORT.chapters.slice(0, reached + 1).map(chapter => (
                <article key={chapter.title}><h3>{chapter.title}</h3><p>{chapter.body}</p><i aria-hidden="true" /><i aria-hidden="true" /></article>
              ))}
            </div>
          </div>
        </div>
        <footer>
          <p className={styles.reportIntro}>{J_REPORT.intro}</p>
          <Button size="sm" tabIndex={-1} className={styles.juryEntry} data-on={!writing || undefined}>
            <Sparkles size={14} aria-hidden="true" />{J_REPORT.juryEntry}<span>{J_REPORT.juryTag}</span>
          </Button>
        </footer>
      </section>
    </div>
  );
}

function Message({ line, step, fetchLocal, information }: {
  line: TakeoverLine; step: string; fetchLocal: number; information: ReturnType<typeof personaInformation>;
}) {
  if (line.role === 'user') {
    return (
      <div data-message-role="user" className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
        <span className="text-xs text-[var(--text-secondary)]">你 · {step}</span>
        <p className={`mt-1 whitespace-pre-wrap break-words ${result.messageBody}`}>{line.text}</p>
      </div>
    );
  }
  if (line.role === 'risk') {
    return (
      <div data-message-role="assistant" className={styles.risk}>
        <span className={styles.riskLabel}><AlertTriangle size={14} aria-hidden="true" />风险提示 · {step}</span>
        <p>{line.text}</p>
      </div>
    );
  }
  const summary = line.role === 'summary';
  return (
    <>
      <div data-message-role="assistant" className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
        <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" />{summary ? '本步小结' : 'AI 自媒体陪跑教练'} · {step}</span>
        <MentorMarkdown className={`mt-1 ${result.messageBody}`} text={line.text} live={false} />
        {line.card ? <Card card={line.card} fetchLocal={fetchLocal} /> : null}
      </div>
      {line.card === 'confirm' || line.card === 'pending' ? <ConfirmJ step={step} information={information} /> : null}
    </>
  );
}

function Card({ card, fetchLocal }: { card: TakeoverCard; fetchLocal: number }) {
  if (card === 'question') return <div className={styles.cardSlot}><QuestionCardView card={J_PERSONA_QUESTION} heading={J_QUESTION_HEADING} /></div>;
  if (card === 'direction') return <div className={styles.cardSlot}><QuestionCardView card={J_PERSONA_DIRECTION} heading={J_QUESTION_HEADING} /></div>;
  if (card === 'kinds') {
    return (
      <ul className={styles.kinds}>
        {J_PERSONA_KINDS.map(item => <li key={item.kind}><b>{item.kind}</b><span>{item.who}</span><em>{item.learn}</em></li>)}
      </ul>
    );
  }
  if (card === 'fetch') {
    const fetched = Math.min(J_PERSONA_KINDS.length, Math.floor(fetchLocal * 4));
    return (
      <ul className={styles.fetch}>
        {J_PERSONA_KINDS.map((item, index) => (
          <li key={item.kind} data-done={index < fetched || undefined}>
            {index < fetched ? <Check size={15} aria-hidden="true" /> : <Loader2 size={15} aria-hidden="true" />}
            {item.kind}<span>{index < fetched ? '已取到公开数据' : '正在抓取'}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (card === 'plan') {
    return <dl className={styles.planRows}>{J_PLAN_ROWS.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
  }
  if (card === 'table') {
    return (
      <div className={styles.tableCard}>
        <p>{J_BENCHMARK_TABLE.title}</p>
        <table>
          <thead><tr>{J_BENCHMARK_TABLE.columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
          <tbody>
            {J_BENCHMARK_TABLE.rows.map(row => (
              <tr key={row[0]}>{row.map((cell, index) => (index === 0
                ? <th key={index} scope="row">{cell}</th>
                : <td key={index} data-missing={cell === '未取到' || undefined}>{cell}</td>))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}
