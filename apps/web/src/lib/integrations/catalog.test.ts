/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { connectMessage, INTEGRATIONS, trackedLink } from './catalog';

describe('integration modules', () => {
  it('each module has its introduction, when to use it, and https links to its own pages', () => {
    expect(INTEGRATIONS.map(module => module.id)).toEqual(['shotviva']);
    for (const module of INTEGRATIONS) {
      expect(module.features.length).toBeGreaterThan(0);
      expect(module.whenToUse.length).toBeGreaterThan(0);
      for (const url of [module.viewUrl, module.buyUrl]) {
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        // Tracking is added by trackedLink only.
        expect([...parsed.searchParams.keys()]).toEqual([]);
      }
    }
  });

  it('the copy carries no amounts of our own (no digits, prices or quotas; the Owner confirmed the wording 2026-11-13)', () => {
    for (const module of INTEGRATIONS) {
      for (const line of [module.tagline, module.philosophy ?? '', ...module.features, ...module.whenToUse, ...(module.inGraylum ?? [])]) {
        expect(line, line).not.toMatch(/[¥$￥]|元|美元|积分\s*[0-9一二三四五六七八九十百千万]|[0-9一二三四五六七八九十百千万]+\s*(?:元|积分|张免费)/);
        expect(line, line).not.toMatch(/[0-9０-９]/);
      }
    }
  });

  it('a link marks Graylum as the source with Shotviva\'s partner marker and utm_*, never the affiliate ref', () => {
    const view = new URL(trackedLink('https://shotviva.com/zh', 'shotviva', 'view'));
    expect(view.origin + view.pathname).toBe('https://shotviva.com/zh');
    expect(Object.fromEntries(view.searchParams)).toEqual({ from: 'graylum', utm_source: 'graylum', utm_medium: 'integration',
      utm_campaign: 'shotviva', utm_content: 'view' });
    const buy = new URL(trackedLink('https://shotviva.com/zh/pricing?ref=someone', 'shotviva', 'buy'));
    expect(buy.searchParams.get('utm_content')).toBe('buy');
    expect(buy.pathname).toBe('/zh/pricing');
    expect(trackedLink('https://shotviva.com/zh', 'shotviva', 'view')).not.toContain('ref=graylum');
  });

  it('Shotviva\'s copy is the Owner\'s confirmed version (2026-11-13), word for word', () => {
    const shotviva = INTEGRATIONS[0]!;
    expect(shotviva.tagline).toBe('Shotviva 是一款为普通人和小商家打造的 AI 照片工作室：用手机拍下的真实照片，选一个模板，三步就能做出能直接用的商品图、菜品图和宣传图。');
    expect(shotviva.philosophy).toBe('我们相信，好看的照片不该只属于会写提示词、会用专业软件的人。Shotviva 保留你拍下的真实主体，只帮你换光线、场景和风格；不用写任何提示词，先看到效果再动手。');
    expect(shotviva.inGraylum?.[1]).toBe('Graylum 只保存你的 Shotviva 账号 ID；在对话里配图时，会把你的出图要求发给 Shotviva 生成。Graylum 拿不到你的 Shotviva 密码。');
  });

  it('the page says in plain words what came back from Shotviva', () => {
    expect(connectMessage({ connected: 'connected' })).toMatchObject({ tone: 'success' });
    for (const code of ['SHOTVIVA_STATE_INVALID', 'SHOTVIVA_CODE_INVALID', 'SHOTVIVA_MEMBERSHIP_REQUIRED', 'SHOTVIVA_ACCOUNT_CLOSED',
      'SHOTVIVA_BUSY', 'SHOTVIVA_UNAVAILABLE', 'LOGIN_REQUIRED']) {
      const message = connectMessage({ error: code });
      expect(message?.tone).toBe('error');
      expect(message?.text).not.toMatch(/SHOTVIVA_|[A-Z]{4,}_/);
    }
    expect(connectMessage({ error: 'anything-else' })).toEqual(connectMessage({ error: 'SHOTVIVA_UNAVAILABLE' }));
    expect(connectMessage({})).toBeNull();
  });
});
