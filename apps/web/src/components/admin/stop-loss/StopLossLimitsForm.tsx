/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { StaleDataNotice } from './StaleDataNotice';
import { STOP_LOSS_QUERY_OPTIONS, formatUsd, parseUsdInput, reachedLimit, stopLossErrorMessage } from './stopLossFormat';

const AMOUNT_FIELDS = [
  ['userDailyUsd', '每位用户每日上限（美元）', '某位用户当天实际成本达到后，该用户的新调用被拒绝。'],
  ['siteDailyUsd', '全站每日上限（美元）', '全站当天实际成本达到后，所有新调用被拒绝。'],
  ['siteAlertUsd', '全站每日提醒线（美元）', '只记录告警，不拒绝调用。'],
  ['providerBalanceAlertUsd', '供应商余额提醒线（美元）', '手动记录的余额低于或等于它、或超过 24 小时没有记录时告警。'],
] as const;
type AmountField = typeof AMOUNT_FIELDS[number][0];
type Config = Record<AmountField, string | null> & { version: 1; notificationChannel: string | null };
type Draft = Record<AmountField | 'notificationChannel', string>;

const toDraft = (config: Config): Draft => ({
  userDailyUsd: config.userDailyUsd ?? '', siteDailyUsd: config.siteDailyUsd ?? '',
  siteAlertUsd: config.siteAlertUsd ?? '', providerBalanceAlertUsd: config.providerBalanceAlertUsd ?? '',
  notificationChannel: config.notificationChannel ?? '',
});
const sameConfig = (a: Config, b: Config) => JSON.stringify(toDraft(a)) === JSON.stringify(toDraft(b));

type Usage = { utcDate?: unknown; siteUsd?: unknown };
function UsageSummary({ config, usage, stale }: { config: Config; usage: Usage | null; stale: boolean }) {
  if (!usage) {
    return <p className="text-sm" role="status" data-testid="stop-loss-usage">
      今天的实际成本暂时读取失败（会自动重试）；下面的上限设置仍可修改和保存。
    </p>;
  }
  const site = typeof usage.siteUsd === 'string' ? usage.siteUsd : null;
  const line = (limit: string | null, label: string) => {
    if (limit === null) return <p>{label}：未设置，不拦截。</p>;
    const reached = site !== null && reachedLimit(site, limit);
    return <p>{label}：{formatUsd(limit)}{reached ? '（已达到）' : ''}</p>;
  };
  return <div className="space-y-1 text-sm" data-testid="stop-loss-usage">
    {stale && <p role="status">最新用量暂时读取失败（会自动重试），下面是上一次读取的数字，可能不是最新。</p>}
    <p>今天（UTC {typeof usage.utcDate === 'string' ? usage.utcDate : '—'}）全站实际成本：{formatUsd(site)}</p>
    {line(config.siteDailyUsd, '全站每日上限')}
    {line(config.siteAlertUsd, '全站每日提醒线')}
    <p>
      每位用户每日上限：{config.userDailyUsd === null ? '未设置，不拦截。' : formatUsd(config.userDailyUsd)}
      （这里只看全站汇总，不列出单个用户的用量）
    </p>
    <p className="text-xs">成本按已结算调用的供应商实际美元计算，不含还在进行中的调用，所以可能略微超过上限。</p>
  </div>;
}

/** Daily USD limits, alert thresholds and the notification label; empty = not set. */
export function StopLossLimitsForm() {
  const utils = trpc.useUtils();
  // Editable config and revision come from their own query, so a failing usage aggregate
  // never blocks tightening a cap; the status query only feeds the usage summary.
  const settings = trpc.runtimeRateLimits.stopLossConfig.useQuery(undefined, STOP_LOSS_QUERY_OPTIONS);
  const status = trpc.runtimeRateLimits.stopLossStatus.useQuery(undefined, STOP_LOSS_QUERY_OPTIONS);
  const save = trpc.runtimeRateLimits.updateStopLoss.useMutation();
  const [draft, setDraft] = useState<Draft | null>(null);
  // Revision the edit started from; the server rejects the save if it has moved on.
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ text: string; conflict: boolean } | null>(null);
  const config = settings.data?.config as Config | undefined;
  const revision = settings.data?.revision;
  const current = draft ?? (config ? toDraft(config) : null);
  const parsed = current ? AMOUNT_FIELDS.map(([key]) => [key, parseUsdInput(current[key])] as const) : [];
  const channel = current?.notificationChannel.trim() ?? '';
  const valid = parsed.every(([, result]) => result.ok) && [...channel].length <= 100;
  const zeroLimit = parsed.some(([key, result]) => result.ok && result.value !== null
    && (key === 'userDailyUsd' || key === 'siteDailyUsd') && Number(result.value) === 0);

  function edit(key: keyof Draft, value: string) {
    if (!current || !config) return;
    if (!draft) setBaseRevision(revision ?? null);
    setDraft({ ...current, [key]: value });
    setNotice(null);
    setFailure(null);
  }

  async function submit() {
    const expectedVersion = baseRevision ?? revision;
    if (!current || !config || !valid || expectedVersion === undefined) return;
    const next: Config = { version: 1, notificationChannel: channel === '' ? null : channel,
      userDailyUsd: null, siteDailyUsd: null, siteAlertUsd: null, providerBalanceAlertUsd: null };
    for (const [key, result] of parsed) if (result.ok) next[key] = result.value;
    setBusy(true);
    setNotice(null);
    setFailure(null);
    try {
      const result = await save.mutateAsync({ config: next, expectedVersion });
      setDraft(null);
      setBaseRevision(null);
      await Promise.all([utils.runtimeRateLimits.stopLossConfig.invalidate(),
        utils.runtimeRateLimits.stopLossStatus.invalidate()]);
      setNotice(sameConfig(result.config as Config, next) ? '止损设置已保存（已回读确认）。'
        : '已保存，但回读到的设置和填写的不同，请核对下方显示的当前设置。');
    } catch (error) {
      const err = error as Parameters<typeof stopLossErrorMessage>[0];
      const conflict = err?.data?.code === 'CONFLICT' || err?.data?.httpStatus === 409;
      setFailure({ text: conflict ? stopLossErrorMessage(err, 'save')
        : '保存没有确认成功。你的修改还在，可以点“重新读取当前设置”核对后再保存。', conflict });
    } finally { setBusy(false); }
  }

  function reload() {
    setDraft(null);
    setBaseRevision(null);
    setFailure(null);
    setNotice(null);
    void settings.refetch();
    void status.refetch();
  }

  return <section aria-labelledby="stop-loss-limits-title" className="space-y-3 rounded-md border p-4">
    <h3 id="stop-loss-limits-title" className="font-medium">每日美元上限</h3>
    <p className="text-sm">留空表示不设置、不拦截。填 0 表示当天不允许任何新的计费调用。最多 12 位小数。</p>
    {settings.error && config && <StaleDataNotice onRetry={() => { void settings.refetch(); }} />}
    {settings.error && !config ? <div role="alert" className="space-y-2">
      <p>{stopLossErrorMessage(settings.error, 'read')}</p>
      <Button variant="outline" onClick={reload}>重新读取</Button>
    </div> : !config || !current ? <p>读取中…</p> : <>
      <UsageSummary config={config} stale={Boolean(status.error && status.data)}
        usage={status.data ? (status.data.usage as Usage) : status.error ? null : {}} />
      <p className="text-sm">设置来源：{settings.data?.source === 'configured' ? '已保存的设置' : '默认（全部未设置）'}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {AMOUNT_FIELDS.map(([key, label, hint]) => {
          const bad = !parseUsdInput(current[key]).ok;
          return <div key={key} className="space-y-1">
            <Label htmlFor={`stop-loss-${key}`}>{label}</Label>
            <Input id={`stop-loss-${key}`} inputMode="decimal" placeholder="未设置" value={current[key]}
              disabled={busy} aria-invalid={bad} onChange={event => edit(key, event.target.value)} />
            <p className="text-xs">{bad ? '请填写不带符号的金额，例如 20 或 12.5，或留空。' : hint}</p>
          </div>;
        })}
        <div className="space-y-1">
          <Label htmlFor="stop-loss-channel">通知渠道备注</Label>
          <Input id="stop-loss-channel" placeholder="未设置" value={current.notificationChannel} disabled={busy}
            onChange={event => edit('notificationChannel', event.target.value)} />
          <p className="text-xs">
            {[...channel].length > 100 ? '最多 100 个字。' : '只是备注，外部通知还没有接入，不会发出任何消息。'}
          </p>
        </div>
      </div>
      {zeroLimit && <p role="alert">上限填 0 会让对应范围当天的新计费调用全部被拒绝，请确认这是你想要的。</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !valid || !draft} onClick={() => { void submit(); }}>
          {busy ? '保存中…' : '保存止损设置'}
        </Button>
        {draft && <Button variant="outline" disabled={busy} onClick={reload}>放弃修改</Button>}
      </div>
    </>}
    {notice && !failure && <p role="status">{notice}</p>}
    {failure && <div role="alert" className="space-y-2">
      <p>{failure.text}</p>
      {/* A conflict means the draft is based on an old version; other failures keep the draft and
          its base version, so a save that did commit still surfaces as a conflict next time. */}
      {failure.conflict ? <Button variant="outline" onClick={reload}>放弃修改并重新读取</Button>
        : <Button variant="outline" onClick={() => { setFailure(null); void settings.refetch(); }}>重新读取当前设置</Button>}
    </div>}
  </section>;
}
