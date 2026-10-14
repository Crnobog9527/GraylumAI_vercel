/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));

import { ResearchToolsPanel } from './ResearchToolsSettings';
import { buildInput, enableBlockedReason, researchToolsError, toDraft, type ResearchToolsView } from './researchToolsDraft';

const ADMIN = '00000000-0000-4000-8000-0000000000aa';
function view(attested: Partial<Record<'tikhub' | 'parallel' | 'firecrawl', boolean>> = {}, extra: Partial<ResearchToolsView> = {}): ResearchToolsView {
  const vendor = (v: 'tikhub' | 'parallel' | 'firecrawl') => ({
    enabled: false, hardCapAttested: attested[v] ? { by: ADMIN, at: '2026-10-14T00:00:00.000000Z' } : null,
  });
  return {
    config: {
      version: 1, enabled: false,
      vendors: { tikhub: vendor('tikhub'), parallel: vendor('parallel'), firecrawl: vendor('firecrawl') },
      verifiedPlatforms: ['tiktok'], benchmarkPlatforms: [], routes: [],
      limits: { maxSubcallsPerRound: 12, discoverSubcalls: 25 }, recentGrowth: { maxFirstPostAgeDays: 90, minViewsToFollowers: '1' },
    },
    source: 'configured', revision: 3, updatedAt: '2026-10-14T00:00:00.000000Z', updatedByEmail: 'admin@example.test',
    hardCapAttestedBy: { tikhub: attested.tikhub ? 'admin@example.test' : null, parallel: null, firecrawl: null },
    historyAvailable: true, history: [], ...extra,
  };
}
const render = (v: ResearchToolsView, draft = toDraft(v), extra: { failure?: string } = {}) =>
  renderToStaticMarkup(createElement(ResearchToolsPanel, {
    view: v, draft, onChange: vi.fn(), onSave: vi.fn(), saving: false, notice: null, failure: extra.failure ?? null,
  }));
const switchTag = (markup: string, vendor: string) => markup.match(new RegExp(`<button[^>]*data-testid="research-vendor-${vendor}"[^>]*>`))?.[0] ?? '';

describe('ResearchToolsPanel', () => {
  it('greys out a supplier switch until its platform hard cap is registered, and says why', () => {
    const markup = render(view({ tikhub: true }));
    expect(switchTag(markup, 'parallel')).toMatch(/disabled=""/);
    expect(markup).toContain('data-testid="research-vendor-parallel-blocked"');
    expect(markup).toContain('还没有登记平台硬上限：请先在 Parallel 后台设好预付余额或消费上限');
    expect(markup).toContain('data-testid="research-vendor-parallel-attest"');
    expect(switchTag(markup, 'tikhub')).not.toMatch(/disabled=""/);
    expect(markup).not.toContain('research-vendor-tikhub-blocked');
    expect(markup).toContain('已登记平台硬上限：admin@example.test');
  });

  it('locks every control while saving or rereading (edits then would be overwritten)', () => {
    const v = view({ tikhub: true });
    const markup = renderToStaticMarkup(createElement(ResearchToolsPanel, {
      view: v, draft: toDraft(v), onChange: vi.fn(), onSave: vi.fn(), saving: true, notice: null, failure: null,
    }));
    expect(switchTag(markup, 'tikhub')).toMatch(/disabled=""/);
    expect(markup).toMatch(/<textarea[^>]*disabled=""/);
    expect(markup).toMatch(/data-testid="research-tools-save"[^>]*disabled=""|disabled=""[^>]*data-testid="research-tools-save"/);
  });

  it('unlocks the switch once the admin ticks the confirmation in this save', () => {
    const v = view();
    const draft = toDraft(v);
    draft.vendors.firecrawl.attest = true;
    const markup = render(v, draft);
    expect(switchTag(markup, 'firecrawl')).not.toMatch(/disabled=""/);
    expect(markup).not.toContain('research-vendor-firecrawl-blocked');
  });

  it('explains a missing or broken stored config and degraded history', () => {
    expect(render(view({}, { source: 'default' }))).toContain('还没有配置过：联网搜索全部关闭。');
    expect(render(view({}, { source: 'invalid' }))).toContain('已存的设置有问题');
    expect(render(view({}, { historyAvailable: false }))).toContain('修改记录暂时读不到');
  });

  it('shows failures as alerts', () => {
    expect(render(view(), undefined, { failure: '保存失败' })).toMatch(/role="alert"[^>]*>保存失败/);
  });
});

describe('research tools draft', () => {
  it('builds the server input with attestations and the read-back revision', () => {
    const v = view({ tikhub: true });
    const draft = toDraft(v);
    draft.enabled = true;
    draft.vendors.tikhub.enabled = true;
    draft.vendors.parallel = { enabled: true, attest: true };
    const built = buildInput(v, draft);
    expect(built).toMatchObject({ ok: true, input: { expectedRevision: 3, attestHardCap: ['parallel'],
      config: { enabled: true, vendors: { tikhub: { enabled: true }, parallel: { enabled: true }, firecrawl: { enabled: false } },
        verifiedPlatforms: ['tiktok'] } } });
    expect(JSON.stringify(built)).not.toContain('hardCapAttested');
  });

  it('refuses to send an unregistered supplier as enabled, or invalid advanced JSON', () => {
    const v = view();
    const draft = toDraft(v);
    draft.vendors.tikhub.enabled = true;
    expect(enableBlockedReason(v, draft, 'tikhub')).toContain('TikHub');
    expect(buildInput(v, draft)).toEqual({ ok: false, error: 'TikHub 还没有登记平台硬上限，不能打开。' });
    expect(buildInput(v, { ...toDraft(v), advanced: '{broken' })).toMatchObject({ ok: false });
    expect(buildInput(v, { ...toDraft(v), advanced: '[]' })).toMatchObject({ ok: false });
  });

  it('maps server errors to plain messages', () => {
    expect(researchToolsError({ data: { code: 'FORBIDDEN' } }, 'read')).toContain('无权');
    expect(researchToolsError({ data: { code: 'CONFLICT' } }, 'save')).toContain('已被其他人修改');
    expect(researchToolsError({ data: { code: 'BAD_REQUEST' }, message: 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' }, 'save')).toContain('硬上限');
    expect(researchToolsError({ data: { code: 'BAD_REQUEST' } }, 'save')).toContain('不符合要求');
  });
});
