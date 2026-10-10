/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TabsContent, TabsTrigger } from '@/components/ui/tabs';

const fields = [
  ['admissionPerMinute', '新消息（每轮消息）：每分钟', 60],
  ['admissionPer24Hours', '新消息（每轮消息）：24小时窗口', 5000],
  ['callsPerMinute', '模型调用：每分钟', 180],
  ['callsPer24Hours', '模型调用：24小时窗口', 15000],
] as const;
/** Largest frozen per-round call count today (/runtime); a lower limit refuses every such round. */
const MAX_CALLS_PER_ROUND = 3;
type Field = typeof fields[number][0];
type Draft = Record<Field, string>;

export function RuntimeRateLimitTabTrigger() {
  return <TabsTrigger value="runtime-rate-limits">AI使用额度</TabsTrigger>;
}

export function RuntimeRateLimitSettings() {
  const utils = trpc.useUtils();
  const view = trpc.runtimeRateLimits.get.useQuery(undefined, { refetchOnMount: 'always' });
  // This component is outside the unmounting TabsContent, preserving edits and save state.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<'limits' | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  // The pre-save re-read counts as saving, so no edit can slip in and be discarded.
  const [rereading, setRereading] = useState(false);
  // Every successful save shows the server read-back, never the submitted value.
  const update = trpc.runtimeRateLimits.update.useMutation({
    onSuccess: data => { utils.runtimeRateLimits.get.setData(undefined, data); },
  });
  const saving = update.isPending || rereading;
  const config = view.data?.config;
  const enforcement = view.data?.enforcement;
  const wired = Boolean(enforcement?.admission && enforcement.calls && enforcement.pause);
  const current = draft ?? (config ? {
    admissionPerMinute: String(config.admissionPerMinute),
    admissionPer24Hours: String(config.admissionPer24Hours),
    callsPerMinute: String(config.callsPerMinute),
    callsPer24Hours: String(config.callsPer24Hours),
  } : null);
  const valid = current && fields.every(([key, , max]) => {
    const n = Number(current[key]);
    return Number.isInteger(n) && n >= 1 && n <= max;
  }) && Number(current.admissionPer24Hours) >= Number(current.admissionPerMinute)
    && Number(current.callsPer24Hours) >= Number(current.callsPerMinute);
  const callsBelowRound = current && Number(current.callsPerMinute) < MAX_CALLS_PER_ROUND;
  return <TabsContent value="runtime-rate-limits">
    <Card>
      <CardHeader>
        <CardTitle>AI使用额度</CardTitle>
        <CardDescription>本卡片单独保存，页面的“保存所有设置”不包含这里。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {wired ? <p role="status">已接线：保存后，下一条新消息或新一轮的第一次模型调用就按新配置检查。</p>
          : <p role="status">保护尚未接线：当前只能准备配置，保存不会启用限流或暂停模型调用。</p>}
        <p>新消息：用户每发一条消息（一轮）记 1 次，同一请求重新读取不再计数。</p>
        <p>
          模型调用：每轮开始时按这一轮最多可用的调用数一次性预扣（导师 1–2 次，/runtime 3 次），
          实际用得少也不退回。已发生的调用费用不受这些配置改变。
        </p>
        {view.error ? <div role="alert">
          无法读取使用额度，请稍后重试。
          <Button onClick={() => { void view.refetch(); }}>重新读取</Button>
        </div> : !config || !current ? <p>读取中…</p> : <>
          <p>配置来源：{view.data?.source === 'default' ? '默认初值' : '已保存配置'}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map(([key, label, max]) => <div key={key} className="space-y-1">
              <Label htmlFor={`rate-${key}`}>{label}</Label>
              <Input id={`rate-${key}`} type="number" min={1} max={max} step={1}
                value={current[key]} disabled={saving}
                onChange={event => {
                  setDraft({ ...current, [key]: event.target.value });
                  setSaved(null);
                  setReadFailed(false);
                  update.reset();
                }} />
              <p className="text-xs">可填 1–{max} 次，日限额不能低于分钟限额。</p>
            </div>)}
          </div>
          <p className="text-sm">
            模型调用每分钟和24小时窗口都不能低于单轮最多调用数（当前 {MAX_CALLS_PER_ROUND}），
            否则需要 {MAX_CALLS_PER_ROUND} 次调用的一轮永远无法开始，用户会看到“暂时无法确认使用额度”。
          </p>
          {callsBelowRound && <p role="alert">
            当前“模型调用：每分钟”低于 {MAX_CALLS_PER_ROUND}，/runtime 的每一轮都会被拒绝。
          </p>}
          {wired ? <p>暂停设置：{config.stopNewCalls ? '已暂停新调用' : '未暂停'}</p>
            : <p>暂停设置：{config.stopNewCalls ? '已保存暂停意向，尚未生效' : '未暂停（保护尚未接线）'}</p>}
          <p className="text-sm">停止或恢复新调用请到“成本止损”页操作，那里有确认步骤。</p>
          <Button disabled={saving || !valid} onClick={() => {
            setSaved(null);
            setReadFailed(false);
            setRereading(true);
            // Re-read the pause flag first: saving limits must never undo a stop set elsewhere.
            void utils.runtimeRateLimits.get.fetch(undefined, { staleTime: 0 }).then(fresh => {
              setRereading(false);
              update.mutate({ ...fresh.config,
                admissionPerMinute: Number(current.admissionPerMinute),
                admissionPer24Hours: Number(current.admissionPer24Hours),
                callsPerMinute: Number(current.callsPerMinute),
                callsPer24Hours: Number(current.callsPer24Hours),
              }, { onSuccess: () => { setDraft(null); setSaved('limits'); } });
            }, () => { setRereading(false); setReadFailed(true); });
          }}>{saving ? '保存中…' : '保存额度配置'}</Button>
        </>}
        {(update.error || readFailed) && <p role="alert">保存或回读失败，请重新读取核对；未确认保存成功。</p>}
        {saved && !view.error && !update.error && config && <p role="status">
          {wired ? '配置已保存并回读。' : '配置已保存并回读；保护仍未接线。'}
        </p>}
        <p className="text-sm">
          Redis 不可用时，{wired ? '新消息和新一轮的第一次模型调用都会被拒绝' : '接线后的新请求将被拒绝'}。运维日志事件
          {/* The long event name must wrap inside a 375px card instead of overflowing. */}
          <code style={{ overflowWrap: 'anywhere' }}>runtime_rate_limit_backend_unavailable_denying_request</code>
          表示新限流器的 Redis 保护不可用，
          不等同于用户次数超限，也不证明一定是免费额度耗尽。请在 Upstash 控制台核对用量。
        </p>
      </CardContent>
    </Card>
  </TabsContent>;
}
