/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Label } from '@/components/ui/label';
import type { PriceChange, PricingSnapshot } from '@repo/api/src/shared/modelPricing';
import { describeChange, routeView, selectedRoute, snapshotAge, type PriceRow, type RouteView } from './modelPriceView';

function PriceTable({ rows }: { rows: PriceRow[] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {rows.map(row => (
          <tr key={row.key} className="border-b border-[var(--border-primary)] last:border-0">
            <td className="py-1 pr-2 text-[var(--text-secondary)]">{row.label}</td>
            <td className="py-1 pr-2 text-right font-mono text-[var(--text-primary)]">{row.value}</td>
            <td className="py-1 text-[var(--text-tertiary)]">{row.unit}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RouteDetails({ view }: { view: RouteView }) {
  return (
    <div className="space-y-2">
      {view.admissible ? null : (
        <p role="status" className="text-amber-400">这条线路的价格无法用于计费：{view.problems.join('；')}</p>
      )}
      <PriceTable rows={view.base} />
      {view.tiers.map((tier, index) => (
        <div key={index} className="space-y-1 rounded border border-[var(--border-primary)] p-2">
          <p className="text-xs text-[var(--text-secondary)]">当 {tier.condition} 时（没列出的项目沿用上面的价格）：</p>
          <PriceTable rows={tier.prices} />
        </div>
      ))}
      <p className="text-xs text-[var(--text-tertiary)]">
        discount：{view.discount ?? '无'}（只记录，不参与计算）
        {view.unknownKeys.length ? `；目录里还有本系统不认识的价格字段：${view.unknownKeys.join('、')}` : ''}
      </p>
    </div>
  );
}

/**
 * Read-only view of the OpenRouter price snapshot (MODEL-PRICING-SYNC PR A).
 * Prices are only ever read from the catalog with the "重新读取" button above;
 * nothing here edits them.
 */
export function ModelPriceSnapshotPanel(props: {
  pricing: PricingSnapshot | null;
  route: string | null;
  modelId: string;
  catalogFetchedAt: string | null;
  changes: PriceChange[] | null;
  now?: number;
}) {
  const { pricing, route, modelId, catalogFetchedAt, changes } = props;
  const now = props.now ?? Date.now();
  const selected = selectedRoute(pricing, route, modelId);
  const age = pricing ? snapshotAge(pricing.fetchedAt, now) : null;
  const others = pricing && pricing.model === modelId ? pricing.endpoints.filter(endpoint => endpoint.tag !== route) : [];
  return (
    <section className="space-y-2" data-testid="model-price-snapshot">
      <Label>OpenRouter 价格（只读）</Label>
      {pricing ? (
        <p className="text-[var(--text-secondary)]">
          价格读取时间 {new Date(pricing.fetchedAt).toLocaleString()}（{age!.days} 天前）；
          思考目录读取时间 {catalogFetchedAt ? new Date(catalogFetchedAt).toLocaleString() : '未读取'}。
          来源 {pricing.source}，校验码 {pricing.pricingHash.slice(0, 8)}。
        </p>
      ) : null}
      {age?.stale ? (
        <p role="status" className="text-amber-400">价格已超过 7 天没有更新，请点上面的"重新读取"。</p>
      ) : null}
      {selected.state === 'missing' ? <p className="text-[var(--text-secondary)]">还没有读取价格。点上面的"重新读取"会同时读取思考目录和价格。</p> : null}
      {selected.state === 'model_changed' ? <p role="status" className="text-amber-400">模型 ID 已变化，价格属于旧的模型，请重新读取。</p> : null}
      {selected.state === 'no_route' ? <p className="text-[var(--text-secondary)]">先选择供应商线路，才会显示这条线路的价格。</p> : null}
      {selected.state === 'route_missing' ? <p role="status" className="text-amber-400">所选线路不在最新的价格里，请重新读取后再选。</p> : null}
      {selected.state === 'ok' ? <RouteDetails view={selected.view} /> : null}
      {changes && changes.length ? (
        <div role="status" className="space-y-1 text-xs text-[var(--text-secondary)]">
          <p>和上次读取相比：</p>
          <ul className="list-disc pl-5">{changes.slice(0, 20).map((change, index) => <li key={index}>{describeChange(change)}</li>)}</ul>
        </div>
      ) : null}
      {changes && !changes.length ? <p role="status" className="text-xs text-[var(--text-secondary)]">价格和上次读取相比没有变化。</p> : null}
      {others.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--text-secondary)]">其他线路的价格（{others.length} 条，供选线路时对比）</summary>
          <div className="mt-2 space-y-3">
            {others.map(endpoint => (
              <div key={endpoint.tag} className="space-y-1">
                <p className="text-[var(--text-primary)]">
                  {endpoint.tag}
                  {endpoint.contextLength ? ` · 上下文 ${endpoint.contextLength.toLocaleString('en-US')}` : ''}
                  {endpoint.admissible ? '' : ' · 不可用于计费'}
                </p>
                <RouteDetails view={routeView(endpoint)} />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
