/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { Columns3, Loader2 } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { profileTabHref } from '@/lib/profile-tabs';
import { compareErrorText, initialPick, isDefiniteRefusal, isUpgradeRefusal, pickStatus, togglePick, type CompareOptions } from './compare-view';
import styles from './compare.module.css';

export type CompareSkill = { kind: 'skill'; moduleId: string; revisionId: string; task?: string };
type Estimate = { credits: number; columns: Array<{ modelId: string; credits: number; usd: string }>; tooLarge: string[];
  refundCapReached: boolean; overBudget: boolean };

/**
 * The composer's "多模型对比" button and its picker (FUSION-COMPARE §3.1, §3.3). Hidden when the switch is off; shown as Gold-only
 * (opening the upgrade page) for a plan without compare. The picker opens with the administrator's default group ticked;
 * the user may untick or pick others within [minModels, maxModels]; "最多消耗 X 积分" is priced by the server for exactly this
 * request and the start carries it, so the group never holds more than the user agreed to.
 */
export function CompareButton({ sessionId, resolveSession, question, skill, disabled, blockedReason, onStarted, onMaybeStarted }: {
  /** The conversation to compare in; absent on the blank new-conversation page, where `resolveSession` creates it on demand. */
  sessionId?: string;
  /** Creates (idempotently, free of charge) or finds the empty conversation a first-message compare hangs on. */
  resolveSession?: () => Promise<string>;
  question: string; skill?: CompareSkill; disabled?: boolean;
  /** Why a compare cannot start with this message (shown as the button's hint), for example an @ library reference. */
  blockedReason?: string;
  onStarted: (compareId: string, names: Record<string, string>, sessionId: string) => void;
  /** A start whose outcome is unknown (the response was lost): the page re-reads the conversation's compares. */
  onMaybeStarted?: () => void;
}) {
  const options = trpc.fusionCompare.options.useQuery(undefined, { staleTime: 60_000, retry: false });
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [sessionError, setSessionError] = useState('');
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
  if (!data || (!data.enabled && data.reason === 'disabled')) return null;
  if (!data.enabled) {
    return <button type="button" className={styles.entry} title="多模型对比是 Gold 会员功能"
      onClick={() => void window.open(profileTabHref('subscription'), '_blank', 'noopener')}><Columns3 size={16} /> 多模型对比 · Gold 专享</button>;
  }
  return <>
    <button type="button" className={styles.entry} disabled={disabled || resolving || !question.trim() || Boolean(blockedReason)}
      title={blockedReason ?? (question.trim() ? undefined : '先写好问题再对比')}
      onClick={() => void openPicker()}><Columns3 size={16} /> 多模型对比</button>
    {sessionError && <span role="status" className={styles.error}>{sessionError}</span>}
    {open && activeSession && <ComparePicker options={data} sessionId={activeSession} question={question} skill={skill}
      onClose={() => setOpen(false)} onMaybeStarted={onMaybeStarted} startId={startId}
      onStarted={(compareId, names) => { setOpen(false); onStarted(compareId, names, activeSession); }} />}
  </>;
}

function ComparePicker({ options, sessionId, question, skill, onClose, onStarted, onMaybeStarted, startId }: {
  options: Extract<CompareOptions, { enabled: true }>; sessionId: string; question: string; skill?: CompareSkill;
  onClose: () => void; onMaybeStarted?: () => void; startId: { current: { key: string; id: string } | null };
  onStarted: (compareId: string, names: Record<string, string>) => void;
}) {
  const [picked, setPicked] = useState(() => initialPick(options));
  const [error, setError] = useState<{ text: string; upgrade: boolean } | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const price = trpc.fusionCompare.estimate.useMutation();
  const start = trpc.fusionCompare.start.useMutation();
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
      const result = await start.mutateAsync({ ...input, requestId,
        shown: { credits: estimate.credits, columns: estimate.columns } });
      // The group exists but holds nothing yet: keep the request id (it outlives this dialog) so a top-up and another click
      // continue the same start instead of meeting FUSION_COMPARE_ACTIVE.
      if (result.state === 'waiting_credits') { setError({ text: `余额不够这次对比的上限（最多 ${estimate.credits} 积分）。充值后再点一次开始，会接着这次对比继续。`, upgrade: false }); return; }
      if (result.state === 'processing') { setError({ text: '正在准备，请稍候再点一次开始。', upgrade: false }); return; }
      startId.current = null;
      onStarted(result.compareId, names);
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
      <DialogContent className={styles.picker}>
        <DialogHeader>
          <DialogTitle>多模型对比</DialogTitle>
          <DialogDescription>同一个问题交给几个模型同时回答，看完选一个继续。已按推荐勾好，也可以自己换。</DialogDescription>
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
            : <>最多消耗 <strong>{estimate.credits}</strong> 积分，按各模型实际用量分别结算；没生成出回答的不收费，开始生成后手动停止的按已用量计费。</>}</p>}
        {error && <p role="alert" className={styles.error}>{error.text}{error.upgrade && <>
          {' '}<a href={profileTabHref('subscription')} target="_blank" rel="noopener">去升级</a></>}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={!status.ready || blocked || start.isPending} onClick={() => void begin()}>
            {start.isPending && <Loader2 size={14} className={styles.spin} />}开始对比</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
