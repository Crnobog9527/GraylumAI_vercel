/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PositioningHeader, PositioningResultPanel, PositioningStepStrip } from './positioning-chrome';

it('renders the header with and without the reopen button', () => {
  const open = renderToStaticMarkup(<PositioningHeader title="我的定位分析" status="整体规划 · 进行中"/>);
  expect(open).toContain('我的定位分析');
  expect(open).toContain('整体规划 · 进行中');
  expect(open).toContain('工作信息');
  expect(open).not.toContain('展开右边栏');
  expect(renderToStaticMarkup(<PositioningHeader title="x" status="y" showExpand/>)).toContain('展开右边栏');
});

it('renders the step strip with the selected and confirmed steps', () => {
  const html = renderToStaticMarkup(<PositioningStepStrip selectedId="diagnose" steps={[
    { id: 'about', title: '了解你', valid: true },
    { id: 'diagnose', title: '诊断与平台对标', valid: false },
    { id: 'plan', title: '定位与执行方案', valid: false, disabled: true },
  ]}/>);
  expect(html).toContain('✓ 了解你');
  expect(html).toContain('2 诊断与平台对标');
  expect(html).toContain('aria-current="step"');
  expect(html).toMatch(/disabled=""[^>]*>3 定位与执行方案/);
});

it('renders the right column frame around its content', () => {
  const html = renderToStaticMarkup(<PositioningResultPanel subtitle="跟着对话自动记录；每一步核对后确认一次"><p>清单内容</p></PositioningResultPanel>);
  expect(html).toContain('定位清单');
  expect(html).toContain('跟着对话自动记录');
  expect(html).toContain('<p>清单内容</p>');
});

it('keeps the title an h1 by default and renders it at the level a page asks for, styled the same', async () => {
  expect(renderToStaticMarkup(<PositioningHeader title="我的定位分析" status="s"/>)).toContain('<h1>我的定位分析</h1>');
  const nested = renderToStaticMarkup(<PositioningHeader title="我的定位分析" status="s" headingLevel="h2"/>);
  expect(nested).toContain('<h2>我的定位分析</h2>');
  expect(nested).not.toContain('<h1');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../opc/positioning-result.module.css', import.meta.url), 'utf8');
  expect(css).toContain('.positionTop :is(h1,h2,:where(');
});
