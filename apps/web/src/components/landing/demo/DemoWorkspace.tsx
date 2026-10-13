/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import { ArrowUp, Box, PanelRightClose, PanelRightOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MessageMarkdown } from '@/components/chat/MessageMarkdown';
import { CaptureChecklist } from '@/components/opc/capture-checklist';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/opc/composer-editor';
import { OTHER_PLACEHOLDER, QuestionCardView } from '@/components/opc/question-card';
import frame from '@/components/opc/workspace-frame.module.css';
import composer from '@/components/opc/work-composer.module.css';
import result from '@/components/opc/positioning-result.module.css';
import { cn } from '@/lib/utils';
import { DemoReportDialog } from './DemoReportDialog';
import {
  DEMO_LABEL, DEMO_NOTE, DEMO_STEPS, demoInformation, demoReducer, initialDemoState, openQuestion, type DemoMessage,
} from './demo-script';
import styles from './demo.module.css';

const noop = () => undefined;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Reveals a new mentor reply a few characters at a time, like the live stream; reduced motion shows it whole.
 * The progress is keyed by the reply's id, so a reply that has not started yet reads as "thinking" in the very
 * render that adds it (never the whole text for a frame first).
 */
function useReveal(liveId: string | null, text: string, onDone: () => void) {
  const [progress, setProgress] = useState<{ id: string; count: number } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!liveId) return;
    if (prefersReducedMotion()) { done.current(); return; }
    let count = -1;
    const cleanup: { timer?: number } = {};
    const start = window.setTimeout(() => {
      const timer = window.setInterval(() => {
        count += 3;
        if (count >= text.length) { window.clearInterval(timer); done.current(); return; }
        setProgress({ id: liveId, count });
      }, 28);
      cleanup.timer = timer;
    }, 550);
    return () => { window.clearTimeout(start); if (cleanup.timer) window.clearInterval(cleanup.timer); };
  }, [liveId, text]);
  if (!liveId || prefersReducedMotion()) return null;
  return progress?.id === liveId ? progress.count : -1;
}

function Message({ message, shown }: { message: DemoMessage; shown: number | null }) {
  if (message.role === 'user') {
    return (
      <div data-message-role="user" className="ml-8 rounded-xl bg-[var(--bg-tertiary)] p-3">
        <span className="text-xs text-[var(--text-secondary)]">{message.label}</span>
        <p className={`mt-1 whitespace-pre-wrap break-words ${result.messageBody}`}>{message.text}</p>
      </div>
    );
  }
  const live = shown !== null;
  return (
    <div data-message-role="assistant" data-step-summary={message.summary || undefined}
      className="mr-4 rounded-xl border border-[var(--border-primary)] p-3">
      <span className={result.agentIdentity}><img src="/graylum-logo.png" alt="" width={22} height={22} />{message.label}</span>
      {live && shown < 0
        ? <p className={cn('mt-1', result.messageBody, styles.thinking)}>导师正在思考…</p>
        : <MessageMarkdown className={`mt-1 ${result.messageBody}`} text={live ? message.text.slice(0, shown) : message.text} streaming={live} />}
    </div>
  );
}

/**
 * The landing demo (module 3): the real conversation components fed with a scripted, made-up case. The visitor
 * can answer the question card, edit and confirm the checklist, open the report and switch panels. No request
 * leaves the page: nothing here imports the tRPC client, Supabase or fetch.
 */
export function DemoWorkspace() {
  const [state, dispatch] = useReducer(demoReducer, undefined, initialDemoState);
  const [rightOpen, setRightOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const box = useRef<ComposerEditorHandle>(null);
  const log = useRef<HTMLDivElement>(null);
  const live = state.messages.find(message => message.id === state.liveId);
  const shown = useReveal(state.liveId, live?.text ?? '', () => dispatch({ type: 'settled' }));
  const card = state.liveId ? null : openQuestion(state);
  const panel = state.panel;
  const send = () => {
    if (!draft.trim() || state.liveId) return;
    dispatch({ type: 'free', text: draft });
    setDraft('');
    box.current?.focus();
  };
  const readyToConfirm = state.phase === 'summary' && !state.liveId;
  const answer = (option: number) => {
    dispatch({ type: 'answer', option });
    log.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [state.messages.length, shown, card]);

  const steps = DEMO_STEPS;
  return (
    <div className={styles.window} role="group" aria-label="教练工作演示（示例）">
      <div className={styles.chrome}>
        <span className={styles.badge}>{DEMO_LABEL}</span>
        <p>{DEMO_NOTE}</p>
        <button type="button" className={styles.restart} onClick={() => { dispatch({ type: 'reset' }); setDraft(''); }}>重新开始</button>
      </div>
      <div role="group" aria-label="切换显示" className={styles.tabs}>
        <button type="button" aria-pressed={panel === 'chat'} onClick={() => dispatch({ type: 'panel', panel: 'chat' })}>对话</button>
        <button type="button" aria-pressed={panel === 'checklist'}
          onClick={() => dispatch({ type: 'panel', panel: 'checklist' })}>
          定位清单{state.checklistUpdated ? <span className={styles.dot} role="status" aria-label="有更新" /> : null}
        </button>
      </div>
      <div className={styles.shell} data-panel={panel} data-right={rightOpen ? 'open' : 'closed'}>
        <section className={cn(frame.center, styles.centerPane)} aria-label="对话">
          <div className={`${result.workspaceMain} ${result.conversationPage} h-full w-full text-[var(--text-primary)]`}>
            <div className={result.workspaceContent}>
              <header className={result.positionTop}>
                <h3 className="m-0 text-[13px] font-medium">我的定位分析</h3>
                <div className={result.positionActions}>
                  <span>整体规划 · {state.valid ? '第一步已确认' : '进行中'}</span>
                  <button type="button" className={styles.hideNarrow} aria-label={rightOpen ? '收起右边栏' : '展开右边栏'}
                    onClick={() => setRightOpen(open => !open)}>
                    {rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
                  </button>
                </div>
              </header>
              <nav aria-label="定位步骤" className={result.phaseStrip} style={{ gridTemplateColumns: `repeat(${steps.length},minmax(0,1fr))` }}>
                {steps.map((step, index) => (
                  <Button key={step.id} variant={index === 0 ? 'default' : 'outline'} aria-current={index === 0 ? 'step' : undefined}
                    disabled={index > 0}>
                    {index === 0 && state.valid ? '✓ ' : `${index + 1} `}{step.title}
                  </Button>
                ))}
              </nav>
              <section aria-label="当前定位步骤">
                <article className={result.stepArticle}>
                  <div className={result.stepColumns}>
                    <div className={result.mentorChat}>
                      <div ref={log} role="log" aria-label="示例对话" aria-live="polite" aria-busy={Boolean(state.liveId)} tabIndex={-1}
                        className="space-y-3">
                        {state.messages.map(message => (
                          <Message key={message.id} message={message} shown={message.id === state.liveId ? shown : null} />
                        ))}
                      </div>
                      <div className={composer.wrap}>
                        <div className={composer.composer}>
                          {card ? (
                            <div className={cn(composer.attachment, styles.attachment)}>
                              <QuestionCardView card={card} docked onAnswer={(_, option) => answer(option)}
                                onOther={() => box.current?.focus()} />
                            </div>
                          ) : null}
                          <ComposerEditor ref={box} label="给导师的回复" placeholder={OTHER_PLACEHOLDER} value={draft} maxLength={8000}
                            onChange={setDraft} onEnter={send} className={composer.editor} />
                          <div className={composer.tools}>
                            <div className={composer.toolLeft}>
                              <div className={composer.menuAnchor}><button type="button" aria-label="添加资料" disabled><Plus size={19} /></button></div>
                              <div className={composer.menuAnchor}><button type="button" aria-label="使用技能" disabled><Box size={18} /></button></div>
                            </div>
                            <div className={composer.toolRight}>
                              <button type="button" aria-label="发送" className={composer.send} disabled={!draft.trim() || Boolean(state.liveId)}
                                onClick={send}><ArrowUp size={18} /></button>
                            </div>
                          </div>
                        </div>
                        {readyToConfirm ? (
                          <Button className={styles.toConfirm} onClick={() => dispatch({ type: 'panel', panel: 'checklist' })}>去定位清单确认这一步</Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              </section>
              <footer className={result.publishBar}>
                <div>
                  <Button variant="outline" disabled={!state.valid || Boolean(state.liveId)}
                    onClick={() => dispatch({ type: 'report', open: true })}>生成报告</Button>
                </div>
                <p>{state.valid ? '示例：点「生成报告」看报告长什么样' : '确认第一步后，可以看示例报告'}</p>
              </footer>
            </div>
          </div>
        </section>
        <aside className={cn(frame.right, styles.rightPane)} aria-label="定位清单">
          <div className={result.panel}>
            <header><h2>定位清单</h2><p>跟着对话自动记录；每一步核对后确认一次</p></header>
            <div className={result.body}>
              <CaptureChecklist steps={DEMO_STEPS} information={demoInformation(state)} valid={{ you: state.valid }}
                edits={{}} selectedStepId="you" editable={!state.valid} manual={false} locked={Boolean(state.liveId)}
                confirmable={() => true} confirmation={() => 'none'} saveState={state.typed.length ? { you: 'saved' } : {}} conflicts={{}} resolving={null}
                onEdit={(_, fieldId, text) => dispatch({ type: 'edit', fieldId, text })} onComposition={noop} onResolve={noop}
                onReview={() => dispatch({ type: 'confirm' })} onRecoverConfirmation={noop} onKeepConflict={noop} onRetrySave={noop} />
            </div>
          </div>
        </aside>
      </div>
      {state.reportOpen ? <DemoReportDialog onClose={() => dispatch({ type: 'report', open: false })} /> : null}
    </div>
  );
}
