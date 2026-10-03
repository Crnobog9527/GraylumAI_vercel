/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from 'node:fs';
import { chromium, expect as browserExpect } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Bill2ModelReportCard } from './Bill2ModelReportCard';

const fixture = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('@/trpc/client', () => ({ trpc: { billingReport: { bill2ByModel: {
  useQuery: () => ({ data: fixture.data, error: null }),
} } } }));

function report(unknown: boolean) {
  const amounts = { officialCostUsd: unknown ? null : '0', weightedUsd: unknown ? null : '0',
    knownOfficialCostUsd: '0', knownWeightedUsd: '0' };
  return { available: true, truncated: false,
    models: [{ provider: 'openrouter', model: 'test/model', calls: 1, unknownCostCalls: unknown ? 1 : 0,
      multipliers: [{ multiplier: '3', source: 'call', calls: 1 }], attributedChargedCredits: 0, ...amounts }],
    totals: { calls: 1, runs: 1, chargedCredits: 0, unallocatedChargedCredits: 0, refundedRuns: 0,
      unsettledRuns: unknown ? 1 : 0, unparsableCalls: 0, ...amounts },
    byPurpose: [{ key: 'interactive', calls: 1, ...amounts }],
    byDate: [{ key: '2026-10-03', calls: 1, ...amounts }],
  };
}

describe('erasure report display', () => {
  it('shows unknown actual costs in model, grouped and summary lines, and v1 nominal as not applicable', () => {
    fixture.data = report(true);
    const html = renderToStaticMarkup(<Bill2ModelReportCard />);
    expect(html.match(/未知（已知部分 \$0）/g)).toHaveLength(8);
    expect(html).toContain('未结清运行单 1 个（关闭不等于结清）');
    expect(html).toContain('PAYG 名义费用：不适用（当前为 v1 合同）');
  });

  it('preserves a proven zero as zero', () => {
    fixture.data = report(false);
    const html = renderToStaticMarkup(<Bill2ModelReportCard />);
    expect(html).not.toContain('未知（已知部分');
    expect(html).toContain('官方成本 $0');
  });

  it('renders unknown and unsettled evidence in a local browser without any network', async () => {
    fixture.data = report(true);
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.abort());
      await page.setContent(renderToStaticMarkup(<Bill2ModelReportCard />));
      await browserExpect(page.getByText('未知（已知部分 $0）', { exact: true }).first()).toBeVisible();
      await browserExpect(page.getByText(/未结清运行单 1 个/)).toBeVisible();
      await browserExpect(page.getByText(/PAYG 名义费用：不适用/)).toBeVisible();
    } finally { await browser.close(); }
  }, 30000);
});
