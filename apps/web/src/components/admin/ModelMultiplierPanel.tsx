/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

// Same rule as the server: 1–20, at most two decimals; blank means "inherit the site default".
export const MULTIPLIER_INPUT_PATTERN = /^(?:(?:[1-9]|1[0-9])(?:\.[0-9]{1,2})?|20(?:\.0{1,2})?)$/;
export const isValidMultiplierInput = (value: string) => value.trim() === '' || MULTIPLIER_INPUT_PATTERN.test(value.trim());

const SOURCE_LABEL = { model: '模型单独设置', global: '继承全站默认', invalid: '数据库里的值无效' } as const;

export function ModelMultiplierPanel() {
  const utils = trpc.useUtils();
  const view = trpc.modelPricing.getMultipliers.useQuery(undefined, { refetchOnMount: 'always' });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const save = trpc.modelPricing.setMultiplier.useMutation({
    onSuccess: (_data, input) => {
      setDrafts((current) => {
        const next = { ...current };
        delete next[input.modelId];
        return next;
      });
      setMessage({ id: input.modelId, text: '已保存并读回' });
      void utils.modelPricing.getMultipliers.invalidate();
    },
    onError: (error, input) => setMessage({ id: input.modelId, text: error.message }),
  });
  const site = view.data?.site;
  return <Card data-testid="model-multiplier-panel">
    <CardHeader>
      <CardTitle>加价倍数（按模型）</CardTitle>
      <CardDescription>
        应收积分 = 每美元积分数 × Σ(每次调用的美元成本 × 该次倍数)，整次操作只进位一次。
        留空表示使用全站默认倍数；修改只影响之后新开始的操作，已冻结的调用不重算。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {view.error ? <div role="alert">
        无法读取加价倍数，请稍后重试。<Button onClick={() => { void view.refetch(); }}>重新读取</Button>
      </div> : !view.data ? <p>读取中…</p> : <>
        <p role="status">{site
          ? `全站：每美元 ${site.creditsPerUsd} 积分（${site.source.creditsPerUsd === 'configured' ? '已配置' : '未配置，使用缺省值'}），`
            + `默认倍数 ${site.defaultMultiplier}（${site.source.defaultMultiplier === 'configured' ? '已配置' : '未配置，使用缺省值'}）。在系统设置里修改。`
          : '全站配置读取失败或无效，新收费会被拒绝；这里不显示推测的默认值。'}</p>
        {!view.data.available ? <p role="alert">模型倍数字段暂不可用（数据库迁移尚未应用或读取失败），暂时不能编辑。</p>
          : <table className="w-full text-sm"><thead><tr>
            <th className="text-left">模型</th><th className="text-left">当前生效</th><th className="text-left">来源</th>
            <th className="text-left">单独设置</th><th />
          </tr></thead><tbody>{view.data.models.map((model) => {
            const draft = drafts[model.id] ?? model.override ?? '';
            const valid = isValidMultiplierInput(draft);
            return <tr key={model.id}>
              <td>{model.name}{model.isActive ? '' : '（已停用）'}<div className="text-xs">{model.modelId}</div></td>
              <td>{model.effective ?? '—'}</td>
              <td>{SOURCE_LABEL[model.source]}</td>
              <td><Input aria-label={`${model.name} 加价倍数`} value={draft} placeholder="留空 = 全站默认" inputMode="decimal"
                disabled={save.isPending} aria-invalid={!valid}
                onChange={(event) => { setDrafts({ ...drafts, [model.id]: event.target.value }); setMessage(null); }} />
                {!valid && <p className="text-xs" role="alert">须为 1–20，最多两位小数</p>}
                {message?.id === model.id && <p className="text-xs" role="status">{message.text}</p>}</td>
              <td><Button disabled={save.isPending || !valid || drafts[model.id] === undefined} onClick={() => save.mutate({
                modelId: model.id, priceMultiplier: draft.trim() === '' ? null : draft.trim(), expectedUpdatedAt: model.updatedAt,
              })}>保存</Button></td>
            </tr>;
          })}</tbody></table>}
      </>}
    </CardContent>
  </Card>;
}
