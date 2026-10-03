/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const UNIT_SOURCE_LABEL = {
  configured: '已配置', default: '未配置，按缺省值', invalid: '配置值无效（新计费会拒绝）', unknown: '来源未知',
} as const;

const WINDOWS = [7, 30, 90] as const;
const SOURCE = { call: '调用冻结', run: '运行单（旧合同）' } as const;

export function Bill2ModelReportCard() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const view = trpc.billingReport.bill2ByModel.useQuery({ days });
  const data = view.data;
  return <Card data-testid="bill2-model-report">
    <CardHeader>
      <CardTitle>按模型的新计费成本（BILL2）</CardTitle>
      <CardDescription>
        官方成本来自每次调用记录的真实费用；加权成本 = 成本 × 该次调用冻结的倍数，
        不是 PAYG 名义费用或现金收入。
        实扣积分的归属：新计费按调用顺序把每次调用带来的累计增量归到它的模型；旧计费只有整单只用一个模型时才归属；
        运行单不完整、费用未知或对不上时列为"未归属"。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex gap-2">{WINDOWS.map((value) => <Button key={value} variant={value === days ? 'default' : 'outline'}
        onClick={() => setDays(value)}>近 {value} 天</Button>)}</div>
      {view.error ? <div role="alert">无法读取，请稍后重试。<Button onClick={() => { void view.refetch(); }}>重新读取</Button></div>
        : !data ? <p>读取中…</p>
        : !data.available ? <p role="alert">报表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示 0 冒充没有费用。</p>
        : <>
          {data.truncated && <p role="alert">记录超过 5000 条，只统计了前 5000 条；请缩短时间范围。</p>}
          <table className="w-full text-sm"><thead><tr>
            <th className="text-left">供应商 / 模型</th><th className="text-right">调用</th><th className="text-right">费用未知</th>
            <th className="text-right">官方成本（美元）</th><th className="text-right">加权成本（美元）</th>
            <th className="text-left">冻结倍数</th><th className="text-right">已归属实扣积分</th>
          </tr></thead><tbody>{data.models.map((line) => <tr key={`${line.provider}/${line.model}`}>
            <td>{line.provider} / {line.model}</td><td className="text-right">{line.calls}</td>
            <td className="text-right">{line.unknownCostCalls}</td>
            <td className="text-right">{costText(line.officialCostUsd, line.knownOfficialCostUsd)}</td>
            <td className="text-right">{costText(line.weightedUsd, line.knownWeightedUsd)}</td>
            <td>{line.multipliers.map((m) => `${m.multiplier}×（${SOURCE[m.source]}，${m.calls} 次）`).join('；')}</td>
            <td className="text-right">{line.attributedChargedCredits}</td>
          </tr>)}</tbody></table>
          <p className="text-xs">合计：{data.totals.calls} 次调用 / {data.totals.runs} 个运行单；
            官方成本 {costText(data.totals.officialCostUsd, data.totals.knownOfficialCostUsd)}；
            加权成本 {costText(data.totals.weightedUsd, data.totals.knownWeightedUsd)}；
            实扣 {data.totals.chargedCredits} 积分，其中未归属 {data.totals.unallocatedChargedCredits}；
            已退款运行单 {data.totals.refundedRuns} 个（不计入实扣）；无法解析的调用（倍数或费用格式无效）{data.totals.unparsableCalls} 次（单独列出，未计入模型）；
            未结清运行单 {data.totals.unsettledRuns} 个（关闭不等于结清）；
            PAYG 名义费用：不适用（当前为 v1 合同）；平台承担：不适用（边用边扣上线后提供）。</p>
          <GroupTable title="按用途" lines={data.byPurpose} />
          <GroupTable title="按日期（UTC）" lines={data.byDate} /></>
        }
    </CardContent>
  </Card>;
}

function GroupTable({ title, lines }: { title: string; lines: Array<{ key: string; calls: number; officialCostUsd: string | null; weightedUsd: string | null;
  knownOfficialCostUsd: string; knownWeightedUsd: string }> }) {
  return <table className="w-full text-sm"><thead><tr>
    <th className="text-left">{title}</th><th className="text-right">调用</th>
    <th className="text-right">官方成本（美元）</th><th className="text-right">加权成本（美元）</th>
  </tr></thead><tbody>{lines.map((line) => <tr key={line.key}>
    <td>{line.key}</td><td className="text-right">{line.calls}</td>
    <td className="text-right">{costText(line.officialCostUsd, line.knownOfficialCostUsd)}</td>
            <td className="text-right">{costText(line.weightedUsd, line.knownWeightedUsd)}</td>
  </tr>)}</tbody></table>;
}

function costText(value: string | null, known: string) {
  return value === null ? `未知（已知部分 $${known}）` : `$${value}`;
}
