/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const UNIT_SOURCE_LABEL = {
  configured: '已配置', default: '未配置，按缺省值', invalid: '配置值无效（新计费会拒绝）', unknown: '来源未知',
} as const;

const WINDOWS = [1, 7, 30, 90] as const;

/** A cost with unknown calls is shown as unknown (with the known part), never as a sum that looks complete. */
export function costText(unknownCalls: number, known: string) {
  return unknownCalls > 0 ? `未知（已知部分 $${known}）` : `$${known}`;
}

export function TurnModelReportCard() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const view = trpc.billingReport.turnByModel.useQuery({ days });
  const data = view.data;
  return <Card data-testid="turn-model-report">
    <CardHeader>
      <CardTitle>按模型的调用成本（对话回合）</CardTitle>
      <CardDescription>
        来自每次模型调用记录的名义费用和实际费用；费用还未确定的调用单独计数，不按 0 计入。
        实扣积分是这段时间内开始的回合的合计，其中平台承担的部分单列。
      </CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      <div className="flex gap-2">{WINDOWS.map((value) => <Button key={value} variant={value === days ? 'default' : 'outline'}
        onClick={() => setDays(value)}>近 {value} 天</Button>)}</div>
      {view.error ? <div role="alert">无法读取，请稍后重试。<Button onClick={() => { void view.refetch(); }}>重新读取</Button></div>
        : !data ? <p>读取中…</p>
        : !data.available ? <p role="alert">报表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示 0 冒充没有数据。</p>
        : <>
          <table className="w-full text-sm"><thead><tr>
            <th className="text-left">模型</th><th className="text-right">调用</th><th className="text-right">费用未知</th>
            <th className="text-right">名义费用（美元）</th><th className="text-right">实际费用（美元）</th><th className="text-left">冻结倍数</th>
          </tr></thead><tbody>{data.models.map((line) => <tr key={line.model}>
            <td>{line.model}</td><td className="text-right">{line.calls}</td><td className="text-right">{line.unknownCostCalls}</td>
            <td className="text-right">{costText(line.unknownCostCalls, line.nominalUsd)}</td>
            <td className="text-right">{costText(line.unknownCostCalls, line.actualUsd)}</td>
            <td>{line.minMultiplier === line.maxMultiplier ? `${line.minMultiplier}×` : `${line.minMultiplier}× ~ ${line.maxMultiplier}×`}</td>
          </tr>)}</tbody></table>
          <p className="text-xs">合计：{data.totals.calls} 次调用 / {data.totals.turns} 个回合；
            名义费用 {costText(data.totals.unknownCostCalls, data.totals.nominalUsd)}；
            实际费用 {costText(data.totals.unknownCostCalls, data.totals.actualUsd)}；
            实扣 {data.totals.chargedCredits} 积分，平台承担 {data.totals.absorbedCredits} 积分；
            未结清回合 {data.totals.unsettledTurns} 个（关闭不等于结清）。</p>
          <table className="w-full text-sm"><thead><tr>
            <th className="text-left">按日期（UTC）</th><th className="text-right">调用</th><th className="text-right">费用未知</th>
            <th className="text-right">名义费用（美元）</th>
          </tr></thead><tbody>{data.byDate.map((line) => <tr key={line.date}>
            <td>{line.date}</td><td className="text-right">{line.calls}</td><td className="text-right">{line.unknownCostCalls}</td>
            <td className="text-right">{costText(line.unknownCostCalls, line.nominalUsd)}</td>
          </tr>)}</tbody></table></>
        }
    </CardContent>
  </Card>;
}

/** Read-only: the turns recovery has not closed or settled yet. Content-free; an operator matches them by id. */
export function UnsettledTurnsCard() {
  const view = trpc.billingReport.unsettledTurns.useQuery();
  const data = view.data;
  return <Card data-testid="unsettled-turns">
    <CardHeader>
      <CardTitle>未结清的对话回合</CardTitle>
      <CardDescription>还没关闭，或已关闭但费用没有结清的回合。系统会自动恢复和结算，这里只读，用来上线后对账。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-2">
      {view.error ? <div role="alert">无法读取，请稍后重试。</div>
        : !data ? <p>读取中…</p>
        : !data.available ? <p role="alert">列表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示 0 冒充没有。</p>
        : data.total === 0 ? <p>当前没有未结清的回合。</p>
        : <>
          <p className="text-xs">共 {data.total} 个{data.total > data.turns.length ? `，只列出最早的 ${data.turns.length} 个` : ''}。</p>
          <table className="w-full text-sm"><thead><tr>
            <th className="text-left">回合</th><th className="text-left">类型</th><th className="text-left">状态</th>
            <th className="text-left">结算</th><th className="text-right">冻结积分</th><th className="text-right">进行中调用</th>
            <th className="text-right">费用待定调用</th><th className="text-left">最后更新</th>
          </tr></thead><tbody>{data.turns.map((turn) => <tr key={turn.turnId}>
            <td>{turn.turnId}</td><td>{turn.kind}</td><td>{turn.state}{turn.closeKind ? `（${turn.closeKind}）` : ''}</td>
            <td>{turn.settlement ?? '—'}</td><td className="text-right">{turn.reservedCredits}</td>
            <td className="text-right">{turn.inFlightCalls}</td><td className="text-right">{turn.costPendingCalls}</td>
            <td>{turn.updatedAt}</td>
          </tr>)}</tbody></table></>
        }
    </CardContent>
  </Card>;
}
