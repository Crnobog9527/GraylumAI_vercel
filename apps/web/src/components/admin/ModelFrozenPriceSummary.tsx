/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Label } from '@/components/ui/label';
import { priceStatusReason, userPricePreview, type ModelPriceView } from './modelReportPricing';

export type MultiplierInfo = { multiplier: string | null; creditsPerUsd: string | null };

/**
 * The frozen prices the server derives for the saved route (plan 3.2 / 3.3), where
 * each comes from, and a reference user price. Read-only; nothing here is saved.
 */
export function ModelFrozenPriceSummary(props: {
  priceView: ModelPriceView;
  selectedRoute: string | null;
  units: MultiplierInfo | null;
}) {
  const { priceView, selectedRoute, units } = props;
  if (priceView.status === 'unread') return null;
  const frozen = priceView.frozen;
  const multiplier = units?.multiplier ?? null, creditsPerUsd = units?.creditsPerUsd ?? null;
  const preview = (usd: string) => userPricePreview(usd, multiplier, creditsPerUsd);
  return (
    <section className="space-y-2 text-sm" data-testid="model-frozen-price">
      <Label>冻结用单价（调用前上限和 OpenRouter 最高价都用它）</Label>
      {selectedRoute !== priceView.route ? (
        <p role="status" className="text-xs text-amber-400">
          下面按已保存的线路 {priceView.route ?? '（未选择）'} 计算；改选的线路保存后才会更新。
        </p>
      ) : null}
      {frozen ? (
        <>
          <ul className="space-y-1 text-xs">
            <li>输入最高单价 ${frozen.promptUsdPerMillion} 美元 / 百万 token（来源：{frozen.explain.prompt}）</li>
            <li>输出最高单价 ${frozen.completionUsdPerMillion} 美元 / 百万 token（来源：{frozen.explain.completion}）</li>
            {frozen.requestUsd !== '0' ? <li>每次请求 ${frozen.requestUsd} 美元 / 次</li> : null}
          </ul>
          {priceView.promptTokensUpper ? (
            <p className="text-xs text-[var(--text-tertiary)]">
              按每次最多 {priceView.promptTokensUpper.toLocaleString('en-US')} 输入 token 判断适用的分档。
            </p>
          ) : null}
          <div className="space-y-1 rounded border border-[var(--border-primary)] p-2 text-xs" data-testid="model-user-price-preview">
            <p className="text-[var(--text-secondary)]">
              用户价预览 = 单价 × 倍数 m（{multiplier ?? '未知'}）× 每美元积分 q（{creditsPerUsd ?? '未知'}）。仅供参考，实扣按实际费用。
            </p>
            {preview(frozen.promptUsdPerMillion) === null ? (
              <p role="status" className="text-amber-400">倍数或每美元积分未知，无法换算；在本页下方"加价倍数"和系统设置里查看。</p>
            ) : (
              <ul>
                <li>输入最多约 {preview(frozen.promptUsdPerMillion)} 积分 / 百万 token</li>
                <li>输出最多约 {preview(frozen.completionUsdPerMillion)} 积分 / 百万 token</li>
              </ul>
            )}
          </div>
        </>
      ) : (
        <p role="status" className="text-xs text-amber-400">
          不可推导：{priceStatusReason(priceView.status)}。按这份价格无法给出冻结用单价。
        </p>
      )}
    </section>
  );
}
