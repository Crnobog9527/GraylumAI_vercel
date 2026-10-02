/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Label } from '@/components/ui/label';
import { capacityRows, capacitySyncChanges, type ModelCapacityView } from './modelReportPricing';

/** Where the "从 OpenRouter 读取" button is, relative to the panel. */
const READ_HINT = {
  dialog: '点上面的"重新读取"',
  form: '在这个模型的"思考设置"里点"重新读取"',
} as const;

/**
 * Read-only context window and maximum output (MODEL-PRICING-SYNC C2). The values
 * come from the supplier route in the OpenRouter catalog and are only written by an
 * explicit catalog read; the administrator cannot type them in.
 */
export function ModelCapacityPanel(props: {
  capacity: ModelCapacityView | null;
  previous?: ModelCapacityView | null;
  selectedRoute?: string | null;
  where: keyof typeof READ_HINT;
  /** Set while the capacity of an existing model is being read, or when that read failed. */
  pending?: 'loading' | 'failed';
}) {
  const { capacity, previous, selectedRoute, where, pending } = props;
  const hint = READ_HINT[where];
  if (pending) {
    return (
      <section className="space-y-1 text-sm" data-testid="model-capacity-panel">
        <Label>上下文限制 / 最大输出 Token（只读）</Label>
        <p role="status" className="text-xs text-[var(--text-secondary)]">
          {pending === 'loading' ? '读取中…' : '暂时无法读取容量，请关闭后重试。'}
        </p>
      </section>
    );
  }
  if (!capacity) {
    return (
      <section className="space-y-1 text-sm" data-testid="model-capacity-panel">
        <Label>上下文限制 / 最大输出 Token（只读）</Label>
        <p className="text-xs text-[var(--text-secondary)]">
          新模型先使用默认值。保存后，在"思考设置"里读取目录、选好线路并保存，再点"重新读取"，系统会按线路同步供应商的值。
        </p>
      </section>
    );
  }
  const rows = capacityRows(capacity);
  const mismatch = rows.some(row => row.mismatch);
  const unknown = capacity.inputLimit.supplier === null || capacity.maxTokens.supplier === null;
  const synced = previous ? capacitySyncChanges(previous, capacity) : [];
  const routeUnsaved = selectedRoute !== undefined && selectedRoute !== capacity.route;
  return (
    <section className="space-y-2 text-sm" data-testid="model-capacity-panel">
      <Label>上下文限制 / 最大输出 Token（只读，来自供应商线路）</Label>
      <p className="text-xs text-[var(--text-secondary)]">
        线路 {capacity.route ?? '未选择'}；目录读取时间 {capacity.fetchedAt ? new Date(capacity.fetchedAt).toLocaleString() : '未读取'}。
      </p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[var(--text-tertiary)]">
            <th className="py-1 text-left font-normal">项目（单位 token）</th>
            <th className="py-1 text-right font-normal">供应商值</th>
            <th className="py-1 text-right font-normal">当前值</th>
            <th className="py-1 text-right font-normal">是否一致</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.field} className="border-t border-[var(--border-primary)]" data-capacity-field={row.field}>
              <td className="py-1 text-[var(--text-secondary)]">{row.label}</td>
              <td className="py-1 text-right font-mono">{row.supplier}</td>
              <td className="py-1 text-right font-mono">{row.current}</td>
              <td className={`py-1 text-right ${row.mismatch ? 'text-amber-400' : ''}`}>{row.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {synced.length ? (
        <p role="status" className="text-xs text-emerald-400">本次读取已按供应商同步：{synced.join('；')}。</p>
      ) : null}
      {routeUnsaved ? (
        <p role="status" className="text-xs text-amber-400">
          你改选了线路但还没保存；这里按已保存的线路显示。先保存，再{hint}，才会同步新线路的值。
        </p>
      ) : null}
      {mismatch ? (
        <p role="status" className="text-xs text-amber-400">当前值和供应商不一致，请{hint}同步。</p>
      ) : null}
      {!mismatch && unknown ? (
        <p className="text-xs text-[var(--text-secondary)]">
          {!capacity.route ? `还没有选线路；选好线路并保存后，${hint}同步。`
            : !capacity.fetchedAt ? `还没有读取这个模型 ID 的目录，请${hint}。`
              : '供应商没有提供这条线路的值，读取时会保留当前值；后台没有手填入口，需要时请联系技术处理。'}
        </p>
      ) : null}
    </section>
  );
}
