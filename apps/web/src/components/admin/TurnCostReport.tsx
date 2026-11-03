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
          <div className="overflow-x-auto"><table className="w-full min-w-max text-sm"><thead><tr>
            <th className="text-left">模型</th><th className="text-right">调用</th>
            <th className="text-right">名义费用未知</th><th className="text-right">实际费用未知</th>
            <th className="text-right">名义费用（美元）</th><th className="text-right">实际费用（美元）</th><th className="text-left">冻结倍数</th>
          </tr></thead><tbody>{data.models.map((line) => <tr key={line.model}>
            <td>{line.model}</td><td className="text-right">{line.calls}</td><td className="text-right">{line.unknownCostCalls}</td>
            <td className="text-right">{line.unknownActualCalls}</td>
            <td className="text-right">{costText(line.unknownCostCalls, line.nominalUsd)}</td>
            <td className="text-right">{costText(line.unknownActualCalls, line.actualUsd)}</td>
            <td>{line.minMultiplier === line.maxMultiplier ? `${line.minMultiplier}×` : `${line.minMultiplier}× ~ ${line.maxMultiplier}×`}</td>
          </tr>)}</tbody></table></div>
          <p className="text-xs">合计：{data.totals.calls} 次调用 / {data.totals.turns} 个回合；
            名义费用 {costText(data.totals.unknownCostCalls, data.totals.nominalUsd)}；
            实际费用 {costText(data.totals.unknownActualCalls, data.totals.actualUsd)}；
            实扣 {data.totals.chargedCredits} 积分，平台承担 {data.totals.absorbedCredits} 积分；
            未结清回合 {data.totals.unsettledTurns} 个（关闭不等于结清）。</p>
          <div className="overflow-x-auto"><table className="w-full min-w-max text-sm"><thead><tr>
            <th className="text-left">按日期（UTC）</th><th className="text-right">调用</th><th className="text-right">费用未知</th>
            <th className="text-right">名义费用（美元）</th>
          </tr></thead><tbody>{data.byDate.map((line) => <tr key={line.date}>
            <td>{line.date}</td><td className="text-right">{line.calls}</td><td className="text-right">{line.unknownCostCalls}</td>
            <td className="text-right">{costText(line.unknownCostCalls, line.nominalUsd)}</td>
          </tr>)}</tbody></table></div></>
        }
    </CardContent>
  </Card>;
}

const MANUAL_AFTER_MS = 24 * 60 * 60 * 1000;
/**
 * A closed turn whose provider cost is still unknown after the 24-hour lookup window (the recovery job looks it up every 10 minutes,
 * then every 6 hours, and never releases the freeze or presumes the cost zero): an operator must settle it by hand.
 */
export function needsManualSettlement(
  turn: { state: string; settlement: string | null; costPendingCalls: number; openedAt: string }, now = Date.now()) {
  const opened = Date.parse(turn.openedAt);
  return turn.state === 'closed' && turn.settlement === 'pending' && turn.costPendingCalls > 0
    && Number.isFinite(opened) && now - opened >= MANUAL_AFTER_MS;
}

/** Read-only: the turns recovery has not closed or settled yet. Content-free; an operator matches them by id. */
function UnsettledTurnsList() {
  const view = trpc.billingReport.unsettledTurns.useQuery();
  const data = view.data;
  return <Card data-testid="unsettled-turns">
    <CardHeader>
      <CardTitle>未结清的对话回合</CardTitle>
      <CardDescription>还没关闭，或已关闭但费用没有结清的回合。系统会自动恢复和结算；
      超过 24 小时仍查不到费用的标“需人工”，冻结不会自动释放。这里只读，用来上线后对账。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-2">
      {view.error ? <div role="alert">无法读取，请稍后重试。</div>
        : !data ? <p>读取中…</p>
        : !data.available ? <p role="alert">列表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示 0 冒充没有。</p>
        : data.total === 0 ? <p>当前没有未结清的回合。</p>
        : <>
          <p className="text-xs">共 {data.total} 个{data.total > data.turns.length ? `，只列出最早的 ${data.turns.length} 个` : ''}。</p>
          <div className="overflow-x-auto"><table className="w-full min-w-max text-sm"><thead><tr>
            <th className="text-left">回合</th><th className="text-left">类型</th><th className="text-left">状态</th>
            <th className="text-left">结算</th><th className="text-right">冻结积分</th><th className="text-right">进行中调用</th>
            <th className="text-right">费用待定调用</th><th className="text-left">最后更新</th>
          </tr></thead><tbody>{data.turns.map((turn) => <tr key={turn.turnId}>
            <td>{turn.turnId}</td><td>{turn.kind}</td><td>{turn.state}{turn.closeKind ? `（${turn.closeKind}）` : ''}</td>
            <td>{turn.settlement ?? '—'}
              {needsManualSettlement(turn) && <strong className="ml-1 text-red-600">需人工</strong>}</td><td className="text-right">{turn.reservedCredits}</td>
            <td className="text-right">{turn.inFlightCalls}</td><td className="text-right">{turn.costPendingCalls}</td>
            <td>{turn.updatedAt}</td>
          </tr>)}</tbody></table></div></>
        }
    </CardContent>
  </Card>;
}

/** Read-only: calls settled at zero because the provider said "no such generation" after 24 hours (Owner 2026-11-03). */
function AbsentRefundsCard() {
  const view = trpc.billingReport.absentRefunds.useQuery();
  const data = view.data;
  return <Card data-testid="absent-refunds">
    <CardHeader>
      <CardTitle>供应商查无而自动退还的调用</CardTitle>
      <CardDescription>开轮满 24 小时后，供应商对该调用的编号明确回答“查无此次生成”，或供应商一直没给出调用编号，
        费用记 0、冻结积分全部退回。如果供应商其实收了钱，由平台承担。每一笔都留在这里，只读。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-2">
      {view.error ? <div role="alert">无法读取，请稍后重试。</div>
        : !data ? <p>读取中…</p>
        : !data.available ? <p role="alert">列表暂不可用（数据库读取函数尚未应用或读取失败）；这里不显示 0 冒充没有。</p>
        : data.total === 0 ? <p>还没有这类调用。</p>
        : <>
          <p className="text-xs">共 {data.total} 笔{data.total > data.calls.length ? `，只列出最近的 ${data.calls.length} 笔` : ''}。</p>
          <div className="overflow-x-auto"><table className="w-full min-w-max text-sm"><thead><tr>
            <th className="text-left">回合</th><th className="text-left">调用</th><th className="text-left">供应商编号</th>
            <th className="text-left">查询结果</th><th className="text-right">冻结积分</th><th className="text-right">实扣积分</th>
            <th className="text-left">结清时间</th>
          </tr></thead><tbody>{data.calls.map((call) => <tr key={`${call.turnId}-${call.seq}`}>
            <td>{call.turnId}</td><td>{call.seq}</td><td className="break-all">{call.providerId ?? '—'}</td>
            <td>{call.source === 'no_identity_24h' ? '无调用编号，满 24 小时' : `HTTP ${call.httpStatus}（查无）`}</td>
            <td className="text-right">{call.reservedCredits}</td><td className="text-right">{call.chargedCredits ?? '—'}</td>
            <td>{call.settledAt}</td>
          </tr>)}</tbody></table></div></>
        }
    </CardContent>
  </Card>;
}

export function UnsettledTurnsCard() {
  return <><UnsettledTurnsList /><AbsentRefundsCard /></>;
}
