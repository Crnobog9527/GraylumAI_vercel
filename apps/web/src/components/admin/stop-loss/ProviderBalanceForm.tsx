/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PROVIDERS, formatTime, formatUsd, parseUsdInput, providerLabel, stopLossErrorMessage, type Provider } from './stopLossFormat';

/**
 * Records a balance the administrator read from the provider's own console. Graylum does not
 * read provider balances itself; each record is labelled as a manual observation and is only
 * trusted for 24 hours.
 */
export function ProviderBalanceForm() {
  const record = trpc.runtimeRateLimits.recordProviderBalance.useMutation();
  const [provider, setProvider] = useState<Provider>('openrouter');
  const [amount, setAmount] = useState('');
  const parsed = parseUsdInput(amount);
  const valid = parsed.ok && parsed.value !== null;
  const last = record.data;

  return <section aria-labelledby="provider-balance-title" className="space-y-3 rounded-md border p-4">
    <h3 id="provider-balance-title" className="font-medium">手动记录供应商余额</h3>
    <p className="text-sm">
      在供应商自己的后台看到余额后填在这里。系统不会自动读取余额；每条记录 24 小时内有效，
      过期后按“余额未知”处理（设置了余额提醒线时会告警）。定时检查时才会比较提醒线，记录后不会马上出现告警。
    </p>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor="provider-balance-provider">供应商</Label>
        <select id="provider-balance-provider" value={provider} disabled={record.isPending}
          className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          onChange={event => { setProvider(event.target.value as Provider); record.reset(); }}>
          {PROVIDERS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="provider-balance-amount">当前余额（美元）</Label>
        <Input id="provider-balance-amount" inputMode="decimal" value={amount} disabled={record.isPending}
          aria-invalid={amount !== '' && !parsed.ok}
          onChange={event => { setAmount(event.target.value); record.reset(); }} />
        {amount !== '' && !parsed.ok && <p className="text-xs">请填写不带符号的金额，例如 25 或 3.75。</p>}
      </div>
    </div>
    <Button disabled={!valid || record.isPending}
      onClick={() => { if (parsed.ok && parsed.value !== null) record.mutate({ provider, balanceUsd: parsed.value }); }}>
      {record.isPending ? '记录中…' : '记录余额'}
    </Button>
    {last && !record.error && <p role="status">
      已记录：{providerLabel(last.provider)} 余额 {formatUsd(last.balanceUsd)}，记录时间 {formatTime(last.observedAt)}，
      来源：管理员手动记录，24 小时内有效。
    </p>}
    {record.error && <p role="alert">{record.error.data?.code === 'BAD_REQUEST' || record.error.data?.code === 'FORBIDDEN'
      || record.error.data?.code === 'UNAUTHORIZED' ? stopLossErrorMessage(record.error, 'save')
      : '余额没有确认记录成功，请稍后再试。'}</p>}
  </section>;
}
