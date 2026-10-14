/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { AlertTriangle, Check, FileText, Loader2, Sparkles } from 'lucide-react';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { DEMO_LABEL, DEMO_STEPS, demoInformation, summaryDemoState, type DemoState } from '@/components/landing/demo/demo-script';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { DraftRow } from '@/components/opc/draft-row';
import result from '@/components/opc/positioning-result.module.css';
import { QuestionCardView } from '@/components/opc/question-card';
import { StepConfirmCard } from '@/components/opc/step-confirm-card';
import frame from '@/components/opc/workspace-frame.module.css';
import { Button } from '@/components/ui/button';
import { J_PERSONA, J_PERSONA_DIRECTION, J_PERSONA_KINDS, J_PERSONA_QUESTION } from '@/lib/landing/landing-copy-j-persona';
import {
  J_BENCHMARK_TABLE, J_JURY_PLACEHOLDER, J_REPORT, J_TAKEOVER_MOMENTS, type TakeoverCard, type TakeoverLine,
} from '@/lib/landing/landing-copy-j-takeover';
import { cn } from '@/lib/utils';
import styles from './takeover-j.module.css';

const noop = () => undefined;
const STEP_FIELDS = [['experience', 'time', 'audience'], ['direction', 'risk'], ['accounts']] as const;

/** The checklist with this person's values for every step up to `done` (exclusive), the product's own field ids. */
export function personaState(done: number): DemoState {
  const values: DemoState['values'] = {};
  STEP_FIELDS.slice(0, done).flat().forEach(id => { values[id] = { value: J_PERSONA.values[id], status: 'confirmed', nature: 'fact' }; });
  return { ...summaryDemoState(), values, typed: [] };
}

/** How many of a moment's messages have arrived at `local` (0 → 1): the first at once, the last a little before the end. */
export function arrivedAt(local: number, count: number) {
  return Math.min(count, Math.max(1, Math.floor(local * count * 1.15) + 1));
}

/**
 * The real product's positioning workspace, played by the scroll: the workspace sidebar (新对话, the feature links,
 * the draft under 待归类), the workbench (我的定位分析, its step strip, the conversation, the footer with 生成完整报告)
 * and the 定位清单 on the right filling in. After the three steps the report is written in its own panel, and from the
 * report the jury is opened. `moment` indexes J_TAKEOVER_MOMENTS; `local` is how far into it (0 → 1).
 */
export function PositioningClipJ({ moment, local }: { moment: number; local: number }) {
  const current = J_TAKEOVER_MOMENTS[moment] ?? J_TAKEOVER_MOMENTS[0];
  const step = current.step;
  const done = local >= 0.96 || step === 3;
  const confirmed = step === 3 ? 3 : step + (done ? 1 : 0);
  const valid = Object.fromEntries(DEMO_STEPS.map((item, index) => [item.id, index < confirmed]));
  const chatMoment = step === 3 ? J_TAKEOVER_MOMENTS[2] : current;
  const lines = step === 3 ? chatMoment.lines : current.lines.slice(0, arrivedAt(local, current.lines.length));
  const fetchLocal = step === 3 ? 1 : Math.max(0, local * 3 - 1.4);
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
          <div className={result.positionActions}><span className={styles.sample}>{DEMO_LABEL}</span><span>整体规划 · {step === 3 ? '已确认' : '进行中'}</span></div>
        </header>
        <nav aria-label="定位步骤" className={result.phaseStrip} style={{ gridTemplateColumns: `repeat(${DEMO_STEPS.length},minmax(0,1fr))` }}>
          {DEMO_STEPS.map((item, index) => (
            <Button key={item.id} size="sm" variant={index === Math.min(step, 2) ? 'default' : 'outline'} tabIndex={-1}>
              {valid[item.id] ? <Check size={14} aria-hidden="true" /> : `${index + 1} `}{item.title}
            </Button>
          ))}
        </nav>
        <div className={styles.log}>
          <div className={styles.logInner}>
            {lines.map((line, index) => (
              <Message key={`${chatMoment.id}-${index}`} line={line} step={DEMO_STEPS[Math.min(step, 2)].title} fetchLocal={fetchLocal} />
            ))}
          </div>
        </div>
        <footer className={cn(result.publishBar, styles.footer)}>
          <span>{step === 3 ? '三步都已确认' : `第 ${step + 1} 步 · 共 3 步`}</span>
          <Button size="sm" variant="outline" tabIndex={-1} data-on={current.id === 'report' || undefined}>{J_REPORT.generate}</Button>
        </footer>
      </section>

      <aside className={cn(result.panel, styles.checklist)}>
        <header><h2>定位清单</h2><p>跟着对话自动记录；每一步核对后确认一次</p></header>
        <div className={result.body}>
          <CaptureChecklist steps={DEMO_STEPS} information={demoInformation(personaState(confirmed))} valid={valid} edits={{}}
            selectedStepId={DEMO_STEPS[Math.min(step, 2)].id} editable={false} manual={false} locked confirmable={() => false}
            confirmation={() => 'none'} saveState={{}} conflicts={{}} resolving={null} onEdit={noop} onComposition={noop}
            onResolve={noop} onReview={noop} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
        </div>
      </aside>

      {step === 3 ? <Report writing={current.id === 'report'} local={local} jury={current.id === 'jury'} /> : null}
    </div>
  );
}

/** The report panel over the workbench: written section by section, then the jury opened from it. */
function Report({ writing, local, jury }: { writing: boolean; local: number; jury: boolean }) {
  const shown = writing ? Math.max(1, Math.ceil(local * 1.2 * J_REPORT.sections.length)) : J_REPORT.sections.length;
  return (
    <div className={styles.reportLayer}>
      <section className={styles.report} aria-label={J_REPORT.title}>
        <header>
          <FileText size={16} aria-hidden="true" /><h2>{J_REPORT.title}</h2>
          {writing && shown < J_REPORT.sections.length ? <small><Loader2 size={13} aria-hidden="true" />正在写报告…</small> : null}
        </header>
        <p className={styles.reportIntro}>{J_REPORT.intro}</p>
        {J_REPORT.sections.slice(0, shown).map(section => <div key={section.title}><h3>{section.title}</h3><p>{section.body}</p></div>)}
        <footer>
          <Button size="sm" tabIndex={-1} data-on={jury || undefined} className={styles.juryEntry}>
            <Sparkles size={14} aria-hidden="true" />{J_REPORT.juryEntry}<span>{J_REPORT.juryTag}</span>
          </Button>
        </footer>
      </section>
      {jury ? <div className={styles.placeholder} data-on={local > 0.15 || undefined}><p>{J_JURY_PLACEHOLDER}</p></div> : null}
    </div>
  );
}

function Message({ line, step, fetchLocal }: { line: TakeoverLine; step: string; fetchLocal: number }) {
  if (line.role === 'user') {
    return (
      <div data-message-role="user" className={styles.user}>
        <MessageMarkdown className={styles.messageText} text={line.text} />
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
  return (
    <div data-message-role="assistant" className={styles.coach}>
      <span className={result.agentIdentity}>导师 · {step}</span>
      <MessageMarkdown className={styles.messageText} text={line.text} />
      {line.card ? <Card card={line.card} fetchLocal={fetchLocal} /> : null}
    </div>
  );
}

function Card({ card, fetchLocal }: { card: TakeoverCard; fetchLocal: number }) {
  if (card === 'question') return <div className={styles.cardSlot}><QuestionCardView card={J_PERSONA_QUESTION} /></div>;
  if (card === 'direction') return <div className={styles.cardSlot}><QuestionCardView card={J_PERSONA_DIRECTION} /></div>;
  if (card === 'confirm') {
    return (
      <div className={styles.cardSlot}>
        <StepConfirmCard stepId="you" title={DEMO_STEPS[0].title} info={demoInformation(personaState(1)).you} edits={undefined}
          signal={undefined} resuming={false} disabled stays={false} canConfirm={false} onConfirm={noop} onEdit={noop} onReview={noop} />
      </div>
    );
  }
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
  if (card === 'report') return null;
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
