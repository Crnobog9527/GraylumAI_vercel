/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { readValidationIssueMessages } from '@/lib/safe-error-message';

const EMPTY = { version: 1, entries: [] };
const FIELDS = 'provider、route（精确线路，通用条目填 null）、appliesToUnlistedRoutes、currency、usageUnit、unitsPerPrice、price、'
  + 'usdPerCurrency / fxSourceUrl / fxEffectiveAt / fxValidUntil（非美元必填，美元填 null）、pricingBasis、sourceUrl、evidenceHash、'
  + 'verifiedAt、validUntil、chargeCondition、includedInReceipt、priceMultiplier（留 null = 全站默认）';

/** Parses the editor text; returns null on invalid JSON so nothing is sent. */
export function parseProviderPricesDraft(text: string): unknown | null {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export function ProviderPricesEditor() {
  const utils = trpc.useUtils();
  const view = trpc.modelPricing.getProviderPrices.useQuery(undefined, { refetchOnMount: 'always' });
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const save = trpc.modelPricing.setProviderPrices.useMutation({
    onSuccess: () => {
      setDraft(null);
      setMessage('已保存并读回');
      void utils.modelPricing.getProviderPrices.invalidate();
    },
    onError: (error) => {
      setMessage(readValidationIssueMessages(error.message) ?? error.message);
      if (error.data?.code === 'CONFLICT') void utils.modelPricing.getProviderPrices.invalidate();
    },
  });
  const data = view.data;
  const text = draft ?? (data ? JSON.stringify(data.config ?? EMPTY, null, 2) : '');
  const parsed = parseProviderPricesDraft(text);
  return <Card data-testid="provider-prices-editor">
    <CardHeader>
      <CardTitle>第三方服务价格（按供应商 / 线路）</CardTitle>
      <CardDescription>
        搜索、抓取等第三方服务的官方价格，先换成美元再按倍数计费。没有配置的线路不能收费。
        新计费启用后才生效；保存时服务端会完整校验，别人先保存过时会提示刷新。字段：{FIELDS}。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {view.error ? <div role="alert">无法读取，请稍后重试。<Button onClick={() => { void view.refetch(); }}>重新读取</Button></div>
        : !data ? <p>读取中…</p> : <>
          <p role="status">{data.source === 'absent' ? '尚未配置：所有第三方线路都不能收费。'
            : data.source === 'invalid' ? '已保存的配置无效，新收费会被拒绝；请修正后保存覆盖。'
            : `已配置 ${data.config?.entries.length ?? 0} 条。`}</p>
          <Textarea aria-label="第三方服务价格 JSON" rows={16} value={text} disabled={save.isPending}
            onChange={(event) => { setDraft(event.target.value); setMessage(''); }} />
          {parsed === null && <p role="alert" className="text-xs">JSON 格式不正确</p>}
          {message && <p role="status" className="text-xs">{message}</p>}
          <Button disabled={save.isPending || draft === null || parsed === null}
            onClick={() => save.mutate({ expectedHash: data.hash, config: parsed })}>保存</Button>
        </>}
    </CardContent>
  </Card>;
}
