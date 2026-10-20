import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/font/local', () => ({ default: () => ({ variable: 'display-font', className: 'display-font' }) }));

import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { SampleH } from '@/components/landing/preview-h/SampleH';
import { SampleJ } from '@/components/landing/preview-j/SampleJ';
import { numberRegions, pickSpot, shortName } from './region-numbers';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const plan = (level: string, monthly: number, yearly: number) => ({
  id: `plan-${level}`, name: level, level, price: { monthly, yearly },
  credits: { monthly: 1000, monthlyBonus: 0 }, discount: 0, checkoutReady: { monthly: true, yearly: true },
});
const names = (html: string) => [...html.matchAll(/data-region="([^"]+)"/g)].map(match => match[1]);
/** True when `wanted` appears in `list` in this order (other names may sit between). */
const inOrder = (list: string[], wanted: string[]) => {
  let at = -1;
  return wanted.every(name => { at = list.indexOf(name, at + 1); return at >= 0; });
};

describe('region numbers of the style samples', () => {
  it('numbers modules from 1 in render order and their sub-blocks N-1, N-2, restarting per module', () => {
    const labels = numberRegions([
      { name: '首屏', level: 1 }, { name: '标题和按钮', level: 2 }, { name: '一周演示', level: 2 },
      { name: '对比区', level: 1 }, { name: '对比卡片', level: 2 }, { name: '页脚', level: 1 },
    ]).map(region => region?.label);
    expect(labels).toEqual(['区域 1 · 首屏', '1-1 · 标题和按钮', '1-2 · 一周演示', '区域 2 · 对比区', '2-1 · 对比卡片', '区域 3 · 页脚']);
  });

  it('a sub-block with no module before it gets no label', () => {
    expect(numberRegions([{ name: '孤块', level: 2 }, { name: '首屏', level: 1 }])).toEqual([
      null, { number: '1', label: '区域 1 · 首屏', level: 1 },
    ]);
  });

  it('an unnamed module is named after its heading, cut short', () => {
    expect(shortName('  AI 教练\n怎么接手你的运营，从第一天开始 ')).toBe('AI 教练 怎么接手…');
    expect(shortName('')).toBe('模块');
  });

  it('puts a label where it covers no text: a sub-block\'s top edge first, else above it, else in the margin', () => {
    const region = { left: 120, top: 400, width: 600, height: 300 };
    const size = { width: 90, height: 20 };
    expect(pickSpot(region, size, 2, [])).toEqual({ dx: 8, dy: -10 });
    const heading = { left: 120, top: 360, width: 600, height: 50 };
    expect(pickSpot(region, size, 2, [heading])).toEqual({ dx: -96, dy: 0 });
    expect(pickSpot({ ...region, left: 16 }, size, 2, [heading]).dx).toBe(8);
    expect(pickSpot(region, { width: 80, height: 23 }, 1, [])).toEqual({ dx: 8, dy: 8 });
  });

  it('samples J and H name their modules in page order (the numbers come from that order, not the markup)', () => {
    const data = buildLandingPageData(ALL_ON, [plan('pro', 29, 279), plan('gold', 69, 621)]);
    const extras = { flags: ALL_ON, showSamples: true };
    const j = names(renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', extras })));
    // Owner 2026-10-16: the takeover story, then the sample reports as their own module, then the work, then the comparison.
    const modules = ['首屏', '用户心声', '接手动画', '样例报告', '省心事项', '对比区', '价格', '常见问题', '结尾行动', '页脚'];
    expect(j.filter(name => modules.includes(name))).toEqual(modules);
    expect(j.join()).not.toMatch(/\d/);
    const h = names(renderToStaticMarkup(createElement(SampleH, { data, siteName: 'Graylum', membershipHref: '/app/profile' })));
    expect(inOrder(h, ['首屏', '适合谁', '为什么不用通用 AI', '用户心声', '怎么用', '价格', '常见问题', '结尾行动', '页脚'])).toBe(true);
  });

  it('only the preview layout mounts the labels; /landing never loads them', () => {
    const app = join(__dirname, '../../../app/landing');
    expect(readFileSync(join(app, 'preview/layout.tsx'), 'utf8')).toContain('<RegionLabels />');
    for (const file of ['layout.tsx', 'page.tsx']) expect(readFileSync(join(app, file), 'utf8')).not.toContain('RegionLabels');
  });
});
