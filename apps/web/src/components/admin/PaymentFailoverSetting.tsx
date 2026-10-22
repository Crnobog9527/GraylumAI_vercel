/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { CreditCard, Loader2, RefreshCw, Save } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  PAYMENT_CHANNEL_OPTIONS, PAYMENT_CHANNEL_SAVE_ERROR_TEXT, buildPaymentChannelSave, classifyPaymentChannelSaveError,
  readPaymentChannelSetting, type PaymentChannel, type SaveErrorKind,
} from './paymentFailoverDraft';

// Bound both the mutation and its confirming read; a timed-out write may still commit.
const SAVE_WAIT_MS = 10_000;
async function withinSaveWait<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('SAVE_RESULT_UNKNOWN')), SAVE_WAIT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

const cardStyle = { background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' };

/**
 * 新购买应急渠道（PAY-FAILOVER）。只影响之后的新购买；已有订单、订阅和凭证仍走原渠道。
 * 保存带上“读到的版本”，被别人抢先保存时服务端返回 CONFLICT：只提示重新读取，不自动重试或覆盖。
 */
export function PaymentFailoverSetting() {
  const channelQuery = trpc.settings.getPaymentMethodRoutes.useQuery(undefined, { retry: false });
  const current = channelQuery.isError ? null : readPaymentChannelSetting(channelQuery.data);
  const [draft, setDraft] = useState<PaymentChannel | null>(null);
  const [readOk, setReadOk] = useState(false);
  // After a save error or a failed read-back, editing stays locked until a fresh read succeeds.
  const [needsReread, setNeedsReread] = useState(false);
  const [rereading, setRereading] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveErrorKind | null>(null);
  const operation = useRef(0);
  useEffect(() => () => { operation.current += 1; }, []);
  // Own the visible operation lifetime: React Query may still be awaiting a lost response.
  const update = trpc.settings.setPaymentFailover.useMutation({ retry: false, networkMode: 'always' });
  const readBack = async () => {
    const channel = await channelQuery.refetch();
    if (channel.isError || !readPaymentChannelSetting(channel.data)) throw new Error('CHANNEL_READ_FAILED');
  };
  const save = async () => {
    if (!current || !draft || saving || rereading || needsReread) return;
    const id = ++operation.current;
    setSaving(true);
    setReadOk(false);
    setSaveError(null);
    try {
      await withinSaveWait((async () => {
        await update.mutateAsync(buildPaymentChannelSave(current, draft));
        if (id !== operation.current) return;
        await readBack();
      })());
      if (id !== operation.current) return;
      setDraft(null);
      setReadOk(true);
    } catch (error) {
      if (id !== operation.current) return;
      const kind = classifyPaymentChannelSaveError(error as { data?: { code?: string } });
      setSaveError(kind);
      setNeedsReread(true);
    } finally {
      if (id === operation.current) {
        operation.current += 1;
        setSaving(false);
      }
    }
  };
  const reread = async () => {
    const id = ++operation.current;
    setRereading(true);
    setReadOk(false);
    try {
      await withinSaveWait(readBack());
      if (id !== operation.current) return;
      update.reset();
      setDraft(null);
      setNeedsReread(false);
      setSaveError(null);
    } catch {
      if (id !== operation.current) return;
      setNeedsReread(true);
      setSaveError('failed');
    } finally {
      if (id === operation.current) {
        operation.current += 1;
        setRereading(false);
      }
    }
  };

  const selected = draft ?? current?.channel ?? null;
  const locked = !current || saving || needsReread || rereading;
  const canSave = !locked && draft !== null && draft !== current?.channel;
  const currentLabel = PAYMENT_CHANNEL_OPTIONS.find(option => option.channel === current?.channel);

  return (
    <Card data-testid="admin-settings-payment-channel-section" className="mb-6" style={cardStyle}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          <CreditCard className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
          新购买应急渠道
        </CardTitle>
        <CardDescription style={{ color: 'var(--text-tertiary)' }}>
          Stripe 为主渠道；风控期间可切到 Waffo，解除后可切回。只影响新购买；已有订单和订阅继续使用原渠道。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {channelQuery.isLoading ? (
          <p style={{ color: 'var(--text-tertiary)' }}>正在读取当前设置…</p>
        ) : !current ? (
          <p role="alert" data-testid="admin-payment-channel-read-error" style={{ color: 'var(--error)' }}>
            现在读不到当前设置，无法确认新购买走哪个渠道。请稍后点“重新读取”。
          </p>
        ) : (
          <p data-testid="admin-payment-channel-current" style={{ color: 'var(--text-secondary)' }}>
            当前选择：{currentLabel?.label}{current.channel === 'waffo' ? '（应急，一次性付款）' : '（主渠道）'} · 版本 {current.version}
          </p>
        )}
        <p style={{ color: 'var(--text-tertiary)' }}>
          切换只影响新建订单；商品映射、准入和支付结果仍按原订单核对。
        </p>
        <div role="radiogroup" aria-label="新购买应急渠道" className="flex flex-col gap-2 sm:flex-row">
          {PAYMENT_CHANNEL_OPTIONS.map(option => (
            <button
              key={option.channel}
              type="button"
              role="radio"
              aria-checked={selected === option.channel}
              data-testid={`admin-payment-channel-option-${option.channel}`}
              disabled={locked}
              onClick={() => { setReadOk(false); setDraft(option.channel); }}
              className="flex-1 rounded-lg border px-3 py-2 text-left disabled:opacity-60"
              style={{
                borderColor: selected === option.channel ? 'var(--color-primary)' : 'var(--border-primary)',
                color: 'var(--text-primary)',
              }}
            >
              <span className="font-medium">{option.label}</span>
              <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>{option.note}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="admin-payment-channel-save"
            size="sm"
            disabled={!canSave}
            onClick={() => void save()}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Save className="mr-1 h-3 w-3" />}
            {saving ? '切换中…' : '切换新购买渠道'}
          </Button>
          <Button data-testid="admin-payment-channel-reread" size="sm" variant="outline" disabled={rereading || saving}
            onClick={() => void reread()}>
            {rereading ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
            重新读取
          </Button>
        </div>
        <div className="text-xs" aria-live="polite">
          {saveError ? (
            <p role="alert" data-testid="admin-payment-channel-save-error" style={{ color: 'var(--error)' }}>
              {PAYMENT_CHANNEL_SAVE_ERROR_TEXT[saveError]}
            </p>
          ) : needsReread ? (
            <p role="alert" style={{ color: 'var(--error)' }}>
              {PAYMENT_CHANNEL_SAVE_ERROR_TEXT.failed}
            </p>
          ) : draft === 'waffo' && current?.channel !== 'waffo' ? (
            <p style={{ color: 'var(--warning)' }}>切到 Waffo 后，所有新购买均为一次性付款，会员不自动续费。结果不明的原付款必须查清后才能再次购买。</p>
          ) : draft !== null && draft !== current?.channel ? (
            <p style={{ color: 'var(--text-tertiary)' }}>有未保存的修改</p>
          ) : readOk ? (
            <p role="status" style={{ color: 'var(--success)' }}>已保存，重新读取确认无误。</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
