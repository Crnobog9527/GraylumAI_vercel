/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';
import { ModelCapacityPanel } from './ModelCapacityPanel';
import { ModelFrozenPriceSummary } from './ModelFrozenPriceSummary';
import { ModelPriceSnapshotPanel } from './ModelPriceSnapshotPanel';
import { ModelReadinessNote } from './ModelReadinessNote';
import { useModelPriceUnits } from './useModelPriceUnits';

/**
 * Read-only prices and capacity in the add / edit model form (plan 3.2 item 2),
 * replacing the removed manual cost fields. Everything comes from the server's
 * `modelReasoning.get` projection of the saved route; reading the catalog and
 * choosing the route stay in the model's "思考设置" dialog.
 */
export function ModelEditPriceSection(props: { modelId: string | null; open: boolean; onShowMultipliers: () => void }) {
  const { modelId, open, onShowMultipliers } = props;
  const view = trpc.modelReasoning.get.useQuery({ modelId: modelId ?? '' }, { enabled: open && Boolean(modelId) });
  const units = useModelPriceUnits(open ? modelId : null);
  if (!modelId) {
    return (
      <section className="space-y-2" data-testid="model-edit-price">
        <ModelReadinessNote priceView={null} />
        <ModelCapacityPanel capacity={null} where="form" />
      </section>
    );
  }
  if (!view.data) {
    return <ModelCapacityPanel capacity={null} where="form" pending={view.error ? 'failed' : 'loading'} />;
  }
  const data = view.data;
  return (
    <section className="space-y-4 text-sm" data-testid="model-edit-price">
      <ModelReadinessNote priceView={data.priceView} />
      <p className="text-xs text-[var(--text-tertiary)]">
        下面按已保存的线路 {data.config.route ?? '（未选择）'} 显示。读取价格、改选线路请到这个模型的"思考设置"。
      </p>
      <ModelPriceSnapshotPanel
        pricing={data.pricing}
        route={data.config.route}
        modelId={data.model}
        catalogFetchedAt={data.config.catalog?.fetchedAt ?? null}
        changes={null}
        where="form"
      />
      <ModelFrozenPriceSummary
        priceView={data.priceView}
        selectedRoute={data.config.route}
        units={units}
        onShowMultipliers={onShowMultipliers}
      />
      <ModelCapacityPanel capacity={data.capacity} where="form" />
    </section>
  );
}
