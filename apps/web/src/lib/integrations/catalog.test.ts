/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { connectMessage, INTEGRATIONS, trackedLink, type IntegrationModule } from './catalog';

/** Every sample picture of a module: the two of 能做什么, then the photo and the result of each kind of use. */
const pictures = (module: IntegrationModule) => (module.showcase
  ? [module.showcase.before, module.showcase.after, ...module.showcase.uses.flatMap(use => [use.before, use.after])] : []);

describe('integration modules', () => {
  it('each module has its introduction, when to use it, and an https link to its own page; no link to buy', () => {
    expect(INTEGRATIONS.map(module => module.id)).toEqual(['shotviva']);
    for (const module of INTEGRATIONS) {
      expect(module.features.length).toBeGreaterThan(0);
      expect(module.whenToUse.length).toBeGreaterThan(0);
      const parsed = new URL(module.viewUrl);
      expect(parsed.protocol).toBe('https:');
      // Tracking is added by trackedLink only.
      expect([...parsed.searchParams.keys()]).toEqual([]);
      // Owner 2026-11-13: "只保留'去查看'". A module has no address to buy at.
      expect(module).not.toHaveProperty('buyUrl');
      expect(JSON.stringify(module)).not.toMatch(/pricing|去购买/);
    }
  });

  it('the copy carries no amounts of our own (no digits, prices or quotas; the Owner confirmed the wording 2026-11-13)', () => {
    for (const module of INTEGRATIONS) {
      // What a poster inside a sample picture says (a date, a discount) is not repeated in the words beside or behind it.
      for (const line of [module.tagline, module.philosophy ?? '', ...module.features, ...module.whenToUse, ...(module.inGraylum ?? []),
        module.showcase?.before.label ?? '', module.showcase?.after.label ?? '', ...pictures(module).map(picture => picture.alt),
        ...(module.showcase?.uses ?? []).flatMap(use => [use.label, use.note])]) {
        expect(line, line).not.toMatch(/[¥$￥]|元|美元|积分\s*[0-9一二三四五六七八九十百千万]|[0-9一二三四五六七八九十百千万]+\s*(?:元|积分|张免费)/);
        expect(line, line).not.toMatch(/[0-9０-９]/);
      }
    }
  });

  it('a link marks Graylum as the source with Shotviva\'s partner marker and utm_*, never the affiliate ref; it is always 去查看', () => {
    const view = new URL(trackedLink('https://shotviva.com/zh', 'shotviva'));
    expect(view.origin + view.pathname).toBe('https://shotviva.com/zh');
    expect(Object.fromEntries(view.searchParams)).toEqual({ from: 'graylum', utm_source: 'graylum', utm_medium: 'integration',
      utm_campaign: 'shotviva', utm_content: 'view' });
    expect(trackedLink('https://shotviva.com/zh', 'shotviva')).not.toContain('ref=graylum');
    expect(trackedLink('https://shotviva.com/zh', 'shotviva')).not.toContain('utm_content=buy');
  });

  it('Shotviva\'s copy is the Owner\'s confirmed version (2026-11-13), word for word', () => {
    const shotviva = INTEGRATIONS[0]!;
    expect(shotviva.tagline).toBe('Shotviva 是一款为普通人和小商家打造的 AI 照片工作室：用手机拍下的真实照片，选一个模板，三步就能做出能直接用的商品图、菜品图和宣传图。');
    expect(shotviva.philosophy).toBe('我们相信，好看的照片不该只属于会写提示词、会用专业软件的人。Shotviva 保留你拍下的真实主体，只帮你换光线、场景和风格；不用写任何提示词，先看到效果再动手。');
    expect(shotviva.inGraylum?.[1]).toBe('Graylum 只保存你的 Shotviva 账号 ID；在对话里配图时，会把你的出图要求发给 Shotviva 生成。Graylum 拿不到你的 Shotviva 密码。');
  });

  it('the lines kept beside the pictures are the earlier ones, unchanged; the pictures carry the two lines that went', () => {
    const shotviva = INTEGRATIONS[0]!;
    expect(shotviva.features).toEqual(['每个模板都保留你拍的主体，只换光线、场景或画风。',
      '用付费积分生成的图是私密的，没有水印；用免费积分做的图会公开展示，并带水印。']);
    expect(shotviva.whenToUse).toEqual(['一次上新很多商品，想用同一个模板整批出图的时候。', '想在 Graylum 写内容的同时，直接把配图也做出来的时候。']);
    expect(shotviva.inGraylum).toEqual(['连接后，在 Graylum 的对话里配图，直接用你的 Shotviva 积分生成，Graylum 不另外收费。',
      'Graylum 只保存你的 Shotviva 账号 ID；在对话里配图时，会把你的出图要求发给 Shotviva 生成。Graylum 拿不到你的 Shotviva 密码。',
      '随时可以在这里断开，也可以在 Shotviva 的账号页里断开。']);
    // "选一个就能出图": a phone photo and what a template made of it.
    expect([shotviva.showcase?.before.label, shotviva.showcase?.after.label]).toEqual(['手机拍的照片', '选一个模板后']);
  });

  it('the kinds of use are the Owner\'s six (2026-11-13), each a photo and what came of it, with one short line', () => {
    const { showcase } = INTEGRATIONS[0]!;
    expect(showcase?.uses.map(use => use.label)).toEqual(['菜品图', '商品图', '房源图', '一键白底图', '一键抠图', '精准编辑图片文字']);
    const file = (src: string) => src.split('/').pop();
    expect([file(showcase!.before.src), file(showcase!.after.src)]).toEqual(['coffee-phone.webp', 'coffee-noir-bar.webp']);
    expect(showcase?.uses.map(use => [file(use.before.src), file(use.after.src)])).toEqual([['salad-phone.webp', 'salad-forest-moss.webp'],
      ['tote-phone.webp', 'tote-promo.webp'], ['room-phone.webp', 'room-staged.webp'], ['dress-phone.webp', 'dress-white.webp'],
      ['hair-phone.webp', 'hair-cutout.webp'], ['poster-before.webp', 'poster-after.webp']]);
    // The sneaker is gone ("案例照片不要用鞋子这一张").
    expect(JSON.stringify(showcase)).not.toMatch(/sneaker|鞋/);
    // Only the cut-out has no background of its own.
    expect(showcase?.uses.filter(use => use.cutout).map(use => use.label)).toEqual(['一键抠图']);
    for (const use of showcase!.uses) {
      expect(use.note.length, use.label).toBeGreaterThan(6);
      expect(use.note.length, use.label).toBeLessThanOrEqual(22);
    }
  });

  it('each sample picture is a webp in the public folder, described in words, and no heavier than 40KB; all of them under 200KB', () => {
    for (const module of INTEGRATIONS) {
      let total = 0;
      expect(new Set(pictures(module).map(picture => picture.src)).size).toBe(pictures(module).length);
      for (const sample of pictures(module)) {
        expect(sample.src).toMatch(new RegExp(`^/integrations/${module.id}/[a-z-]+\\.webp$`));
        expect(sample.alt.length, sample.src).toBeGreaterThan(8);
        const size = statSync(fileURLToPath(new URL(`../../../public${sample.src}`, import.meta.url))).size;
        expect(size, sample.src).toBeGreaterThan(1000);
        // Owner 2026-11-13: "这些图片注意做好压缩，要保证手机版的性能".
        expect(size, sample.src).toBeLessThanOrEqual(40 * 1024);
        total += size;
      }
      expect(total, module.id).toBeLessThanOrEqual(200 * 1024);
    }
  });

  it('the public folder holds no sample picture that the page does not show', () => {
    for (const module of INTEGRATIONS.filter(item => item.showcase)) {
      const folder = fileURLToPath(new URL(`../../../public/integrations/${module.id}`, import.meta.url));
      expect(readdirSync(folder).sort()).toEqual(pictures(module).map(picture => picture.src.split('/').pop()).sort());
    }
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
