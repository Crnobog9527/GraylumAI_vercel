/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { estimateFusion, startCompare } from '@/lib/turn-fusion';
import { turnCompareLive } from './turn-compare-live';
import { COMPARE_NEEDS_QUESTION, registerCompareHost } from './compare-entry';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ReportPaywallDialog } from '@/components/paywall/ReportPaywallDialog';
import { compareErrorText, initialPick, isDefiniteRefusal, isUpgradeRefusal, pickStatus, togglePick, type CompareOptions } from './compare-view';
import styles from './compare.module.css';
import { READ_RETRY } from '@/trpc/read-retry';
import { QueryNotice } from '@/components/opc/query-notice';

export type CompareSkill = { kind: 'skill'; moduleId: string; revisionId: string; task?: string };
type Estimate = { credits: number; columns: Array<{ modelId: string; credits: number; usd: string }>; tooLarge: string[];
  refundCapReached: boolean; overBudget: boolean };

/**
 * The page's side of "多模型对比" (FUSION-COMPARE §3.1, §3.3). The entry itself is in the left rail (Owner 2026-11-12); this
 * mounts next to a message box and answers it: with a question written it opens the picker for this conversation, as the
 * button that used to stand here did; with an empty box it says so under the box and puts the caret there. It draws
 * nothing until asked. A plan without compare never gets here: the rail opens the paywall itself.
 * The picker opens with the administrator's default group ticked; the user may untick or pick others within
 * [minModels, maxModels]; "最多消耗 X 积分" is priced by the server for exactly this request and the start carries it, so
 * the group never holds more than the user agreed to.
 */
export function CompareHost({ sessionId, resolveSession, question, skill, disabled, blockedReason, onStarted, onMaybeStarted }: {
  /** The conversation to compare in; absent on the blank new-conversation page, where `resolveSession` creates it on demand. */
  sessionId?: string;
  /** Creates (idempotently, free of charge) or finds the empty conversation a first-message compare hangs on. */
  resolveSession?: () => Promise<string>;
  question: string; skill?: CompareSkill; disabled?: boolean;
  /** Why a compare cannot start with this message (shown under the box when asked), for example an @ library reference. */
  blockedReason?: string;
  onStarted: (compareId: string, names: Record<string, string>, sessionId: string) => void;
  /** A start whose outcome is unknown (the response was lost): the page re-reads the conversation's compares. */
  onMaybeStarted?: () => void;
}) {
  const options = trpc.fusionCompare.options.useQuery(undefined, { staleTime: 60_000, ...READ_RETRY });
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sessionError, setSessionError] = useState('');
  // The rail asked while the box was empty or held something a compare cannot take: the reason shows until that changes.
  const [asked, setAsked] = useState(false);
  // The paywall the picker itself can lead to (the server refused the start for the plan); the question stays where it is.
  const [paywall, setPaywall] = useState(false);
  // The start request id outlives the dialog: a start that is waiting for credits, or whose outcome is unknown, is continued
  // by the same id when the picker is opened again with the same choice (a new id would meet FUSION_COMPARE_ACTIVE).
  const startId = useRef<{ key: string; id: string } | null>(null);
  const data = options.data as CompareOptions | undefined;
  const activeSession = sessionId ?? resolved;
  async function openPicker() {
    if (activeSession) { setOpen(true); return; }
    if (!resolveSession || resolving) return;
    // First message of a new conversation: make the (empty) conversation first. The same request id always gives the same
    // conversation, so a retry or a second opening never makes another one.
    setResolving(true); setSessionError('');
    try { setResolved(await resolveSession()); setOpen(true); }
    catch { setSessionError('暂时没能开始对话，请稍后再试。输入已保留。'); }
    finally { setResolving(false); }
  }
  const ready = Boolean(data?.enabled) && !disabled && !resolving && Boolean(question.trim()) && !blockedReason;
  // What the rail's entry does on this page. Always the newest state: the handler is registered once and reads this.
  const act = useRef<() => void>(() => undefined);
  act.current = () => {
    if (!data?.enabled) return;
    if (ready) { setAsked(false); void openPicker(); return; }
    setAsked(true);
    // The caret goes to the message box: writing the question is the next thing to do.
    document.querySelector<HTMLElement>('main [contenteditable="true"]')?.focus();
  };
  useEffect(() => registerCompareHost(() => act.current()), []);
  // Said only after the entry was used, and only while it still holds.
  const reason = asked ? (blockedReason ?? (question.trim() ? '' : COMPARE_NEEDS_QUESTION)) : '';
  // A read that still fails after its retries is said, not hidden.
  if (options.isError && !data) return <QueryNotice error={options.error} label="多模型对比" retry={() => options.refetch()} />;
  if (!data?.enabled) return null;
  return <>
    {reason && <span role="status" className={styles.entryHint}>{reason}</span>}
    {sessionError && <span role="status" className={styles.error}>{sessionError}</span>}
    {open && activeSession && <ComparePicker options={data} sessionId={activeSession} question={question} skill={skill}
      onClose={() => setOpen(false)} onMaybeStarted={onMaybeStarted} startId={startId}
      onUpgrade={() => { setOpen(false); setPaywall(true); }}
      onStarted={(compareId, names) => { setOpen(false); onStarted(compareId, names, activeSession); }} />}
    {paywall && <ReportPaywallDialog scene="compare" onClose={() => setPaywall(false)} />}
  </>;
}

function ComparePicker({ options, sessionId, question, skill, onClose, onUpgrade, onStarted, onMaybeStarted, startId }: {
  options: Extract<CompareOptions, { enabled: true }>; sessionId: string; question: string; skill?: CompareSkill;
  onClose: () => void; onUpgrade: () => void; onMaybeStarted?: () => void; startId: { current: { key: string; id: string } | null };
  onStarted: (compareId: string, names: Record<string, string>) => void;
}) {
  const [picked, setPicked] = useState(() => initialPick(options));
  const [error, setError] = useState<{ text: string; upgrade: boolean } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  // Priced by POST /api/turn/estimate, started by POST /api/turn/compare (CORE-PATH-V2 V2-10).
  const [pricing, setPricing] = useState(false), [starting, setStarting] = useState(false);
  const price = { isPending: pricing, mutateAsync: (body: typeof input) => {
    setPricing(true);
    return estimateFusion<Estimate>({ kind: 'compare', ...body }).finally(() => setPricing(false));
  } };
  const start = { isPending: starting };
  const status = pickStatus(picked, options);
  const names = Object.fromEntries(options.models.map(model => [model.id, model.name]));
  const input = { sessionId, question: question.trim(), modelIds: picked, ...(skill ? { skill } : {}) };
  const key = JSON.stringify(input);

  // Priced again whenever the choice changes; a new choice is a new request (a fresh request id at start).
  useEffect(() => {
    setEstimate(null);
    if (!status.ready) return;
    let current = true;
    price.mutateAsync(input).then(result => { if (current) { setEstimate(result as Estimate); setError(null); } })
      .catch(cause => { if (current) setError({ text: compareErrorText(cause), upgrade: isUpgradeRefusal(cause) }); });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the whole request
  }, [key, status.ready]);

  const blocked = !estimate || estimate.tooLarge.length > 0 || estimate.overBudget;
  async function begin() {
    if (!estimate || blocked || start.isPending) return;
    // The same choice continues the same start; a changed choice is a new request.
    if (startId.current?.key !== key) startId.current = { key, id: crypto.randomUUID() };
    const requestId = startId.current.id;
    try {
      // All the columns stream in this one request; the card follows them through the live store and the saved state.
      setStarting(true);
      const shown = { credits: estimate.credits, columns: estimate.columns };
      const turn = startCompare({ ...input, requestId, shown }, { onOpened: turnCompareLive.begin, onColumn: turnCompareLive.column,
        onAnswer: (id, index) => turnCompareLive.answered(id, index) });
      const { compareId } = await turn.started.finally(() => setStarting(false));
      void turn.finished.finally(() => turnCompareLive.end(compareId));
      startId.current = null;
      onStarted(compareId, names);
    } catch (cause) {
      // A definite refusal (a compare error code from the server) ends this request id. Anything else (network, a lost
      // response) may have claimed the group: keep the id so the next click replays the same start instead of meeting
      // FUSION_COMPARE_ACTIVE, and re-read the compares so an already created card shows up.
      if (isDefiniteRefusal(cause)) startId.current = null; else onMaybeStarted?.();
      setError({ text: compareErrorText(cause), upgrade: isUpgradeRefusal(cause) });
    }
  }

  return (
    <Dialog open onOpenChange={value => { if (!value) onClose(); }}>
      <DialogContent tone="light" className={styles.picker}>
        <DialogHeader>
          <DialogTitle>多模型对比</DialogTitle>
          <DialogDescription>
            同一个问题交给几个模型同时回答，看完选一个继续。已按推荐勾好，也可以自己换。
          </DialogDescription>
        </DialogHeader>
        <fieldset className={styles.models}>
          <legend className={styles.muted}>选择 {options.minModels}–{options.maxModels} 个模型</legend>
          {options.models.map(model => {
            const checked = picked.includes(model.id);
            const full = !checked && picked.length >= options.maxModels;
            const tooLarge = estimate?.tooLarge.includes(model.id);
            return <label key={model.id} className={styles.model} data-disabled={full}>
              <Checkbox checked={checked} disabled={full} onCheckedChange={() => setPicked(old => togglePick(old, model.id, options.maxModels))} />
              <span>{model.name}</span>
              {tooLarge && <small className={styles.error}>这次内容放不下</small>}
              {checked && estimate && !tooLarge && <small className={styles.muted}>
                最多 {estimate.columns.find(column => column.modelId === model.id)?.credits ?? '—'} 积分</small>}
            </label>;
          })}
        </fieldset>
        <p className={styles.muted}>{status.hint}</p>
        {status.ready && <p className={styles.estimate} role="status">{price.isPending || !estimate
          ? <><Loader2 size={14} className={styles.spin} /> 正在计算预计消耗…</>
          : estimate.overBudget ? '这次对比超过单次上限，请少选几个模型。'
            : <>最多消耗 <strong>{estimate.credits}</strong> 积分，按各模型实际用量分别结算；没生成出回答的不收费。</>}</p>}
        {error && <p role="alert" className={styles.error}>{error.text}{error.upgrade && <>
          {' '}<button type="button" className="underline" onClick={onUpgrade}>去升级</button></>}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!status.ready || blocked || start.isPending} onClick={() => void begin()}>
            {start.isPending && <Loader2 size={14} className={styles.spin} />}开始对比</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
