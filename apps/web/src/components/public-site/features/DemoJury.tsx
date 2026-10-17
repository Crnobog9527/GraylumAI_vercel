/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { JuryCanvasPlayer } from '@/components/landing/preview-jury/JuryCanvasPlayer';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import theme from '@/components/landing/preview-jury/jury-theme.module.css';
import * as jury from '@/components/chat-display/fixtures/jury';
import { ProductFrame } from './ProductFrame';

/** One feature page's product screen: the product's own display components with the shared example data; every callback is a no-op. */
export function DemoJury() {
  return (
    <div className="space-y-8">
      <ProductFrame label="评审团审阅过程的示例" caption="示例评审：使用示例报告和示例评审名字，不是真实用户的报告">
        <div style={{ height: 560 }}>
          <JuryCanvasPlayer data={jury.SAMPLE_JURY_CASE} names={jury.SAMPLE_JURY_NAMES} brief speed={1} />
        </div>
      </ProductFrame>
      <ProductFrame label="评审团结果页的示例" caption="示例结果页：每一章用修订还是原文，由你逐章决定">
        <div className={theme.theme}>
          <JuryReader detail={jury.SAMPLE_JURY_SCENARIO.detail} names={jury.SAMPLE_JURY_NAMES}
            source={jury.SAMPLE_JURY_READER_SOURCE} actions={jury.SAMPLE_JURY_ADOPT_ACTIONS} />
        </div>
      </ProductFrame>
    </div>
  );
}
