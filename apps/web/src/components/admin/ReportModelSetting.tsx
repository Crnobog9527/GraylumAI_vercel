/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  FOLLOW_DIALOGUE, isReportModelConflict, modelLabel, reportModelChoices, reportModelErrorText,
} from './reportModelView';

const FOLLOW_VALUE = '__follow_dialogue__';
const muted = { color: 'var(--text-tertiary)' };

/**
 * REPORT-MODEL: the model that writes this Skill's report, saved on its own (not with the module
 * form). Empty means "沿用对话模型". Every save sends the value this page read, so an older page
 * cannot overwrite a newer setting; the server re-validates the model.
 */
type SavedHook = () => Promise<boolean>;

export function ReportModelSetting({ moduleId, hasReport, onSaved }: {
  moduleId: string | undefined; hasReport: boolean; onSaved?: SavedHook;
}) {
  if (!moduleId || !hasReport) return null;
  return <ReportModelPanel moduleId={moduleId} onSaved={onSaved} />;
}

function ReportModelPanel({ moduleId, onSaved }: { moduleId: string; onSaved?: SavedHook }) {
  const utils = trpc.useUtils();
  const current = trpc.reportModel.get.useQuery({ moduleId }, { staleTime: 0, retry: false });
  const options = trpc.reportModel.options.useQuery(undefined, { staleTime: 0, retry: false });
  const names = trpc.settings.getSummaryModels.useQuery({ use: 'skill' });
  const update = trpc.reportModel.update.useMutation();
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string; conflict?: boolean } | null>(null);
  const inFlight = useRef(false);

  const saved = current.data?.reportModelId ?? null;
  // Until the admin picks something, the control shows the saved value.
  const value = selected ?? (saved ?? FOLLOW_DIALOGUE);
  useEffect(() => { setSelected(null); }, [saved]);
  const dirty = current.data !== undefined && value !== (saved ?? FOLLOW_DIALOGUE);
  const lists = [options.data?.models, names.data];

  async function save() {
    if (!current.data || !dirty || inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    try {
      const next = await update.mutateAsync({ moduleId, reportModelId: value || null, expectedReportModelId: saved });
      utils.reportModel.get.setData({ moduleId }, next);
      setSelected(null);
      // Saving moves the module version the form above sends back; let the page pick up the new one.
      const synced = onSaved ? await onSaved() : true;
      setNotice(synced ? { tone: 'ok', text: '已保存。新开始的报告使用这个设置，已经开始的报告不受影响。' }
        : { tone: 'error', text: '报告模型已保存，但模块版本没能刷新。要保存上方其他修改，请先关闭窗口再重新打开。' });
    } catch (error) {
      setNotice({ tone: 'error', text: reportModelErrorText(error), conflict: isReportModelConflict(error) });
    } finally {
      inFlight.current = false;
    }
  }

  async function reload() {
    setNotice(null);
    setSelected(null);
    await Promise.all([current.refetch(), options.refetch()]);
  }

  return (
    <section data-testid="report-model-setting" className="space-y-3 rounded-lg border border-[var(--border-primary)] p-4">
      <Label style={{ color: 'var(--text-secondary)' }}>写报告用的模型</Label>
      {current.isLoading ? <p className="text-sm" style={muted}>正在读取报告模型设置…</p>
        : current.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--error)' }}>
            {reportModelErrorText(current.error)}
            <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>重新读取</Button>
          </div>
        ) : current.data ? (
          <>
            <dl className="grid gap-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              <div className="flex flex-wrap gap-2"><dt style={muted}>当前对话模型（已保存）</dt>
                <dd data-testid="report-model-dialogue">{modelLabel(current.data.dialogueModelId, ...lists)}</dd></div>
              <div className="flex flex-wrap gap-2"><dt style={muted}>当前报告实际使用</dt>
                <dd data-testid="report-model-effective">{modelLabel(current.data.effectiveModelId, ...lists)}
                  {current.data.reportModelId ? '' : '（沿用对话模型）'}</dd></div>
            </dl>
            <Select value={value || FOLLOW_VALUE} disabled={update.isPending || options.isLoading}
              onValueChange={next => { setNotice(null); setSelected(next === FOLLOW_VALUE ? FOLLOW_DIALOGUE : next); }}>
              <SelectTrigger aria-label="写报告用的模型" className="bg-[var(--bg-tertiary)] border-[var(--border-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <SelectItem value={FOLLOW_VALUE}>沿用对话模型</SelectItem>
                {reportModelChoices(options.data?.models ?? [], saved, names.data).map(model => (
                  <SelectItem key={model.id} value={model.id} disabled={model.disabled}>{model.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options.isError ? <p className="text-sm" style={{ color: 'var(--warning)' }}>
              暂时读不到可选的报告模型，只能选择“沿用对话模型”。</p> : null}
            <p className="text-xs" style={muted}>只列出已准入写报告、报价有效的模型。这里单独保存，不随上方“保存”提交；
              改对话模型后请重新打开这个窗口查看。</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" data-testid="report-model-save" disabled={!dirty || update.isPending} onClick={() => void save()}>
                {update.isPending ? '正在保存…' : '保存报告模型'}
              </Button>
              {notice?.conflict ? <Button type="button" variant="outline" onClick={() => void reload()}>重新读取</Button> : null}
            </div>
            {notice ? <p role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="report-model-notice" className="text-sm"
              style={{ color: notice.tone === 'error' ? 'var(--error)' : 'var(--success)' }}>{notice.text}</p> : null}
          </>
        ) : null}
    </section>
  );
}
