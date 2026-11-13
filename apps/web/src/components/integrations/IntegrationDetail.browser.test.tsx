/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A product's introduction, opened from its card on the integrations page, in a real browser with the app's CSS (globals.css,
// Tailwind, the CSS modules) and a stand-in for the server. Why it is measured (Owner 2026-11-13, a screenshot of the first
// version): the dialog was the dark one with the light page's dark grey words on it, and the state box had white words on a
// cream ground, so most of it could not be read; and there was no mark of the product. So: every line of words is read against
// what is behind it, in each of the four states; the mark is a picture that loaded; on a phone it is a sheet with its head and
// its link in place while the middle scrolls. Owner 2026-11-13, on staging: only 去查看 at the foot (no 去购买), and the
// introduction said by Shotviva's sample pictures before words. Third look, the same day: both kinds of credits by name; a
// photo and its result for each kind of use; and "要保证手机版的性能": a picture is asked for only when it comes into view.
// INTEGRATION_SHOTS=<dir> saves a screenshot of each state.
import { mkdirSync } from 'node:fs';
import { chromium, expect as ui, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INTEGRATIONS } from '@/lib/integrations/catalog';
import { BALANCE, buildIntegrationsPage, openIntroduction, SHOTS, type StateName } from './__tests__/browser-harness';

let browser: Browser;
let html = '';
const shots = SHOTS;

beforeAll(async () => {
  html = await buildIntegrationsPage();
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

/** The integrations page with Shotviva in the given state, and its introduction opened from its card. */
const open = (state: StateName, width: number, height = 780): Promise<{ page: Page; errors: string[]; asked: string[] }> =>
  openIntroduction(browser, html, state, width, height);

/**
 * Every element of the dialog that has words of its own: the words, and their contrast against the first painted ground behind
 * them (WCAG 2.1 relative luminance; 4.5 is the floor for text of this size).
 */
const words = (page: Page) => page.getByRole('dialog').evaluate(dialog => {
  const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
  const light = (value: string) => {
    const [r = 0, g = 0, b = 0] = rgb(value).map(channel => { const c = channel / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const ground = (element: Element): string => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const value = getComputedStyle(node).backgroundColor;
      if ((rgb(value)[3] ?? 1) > .98) return value;
    }
    return 'rgb(255, 255, 255)';
  };
  return [...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.getClientRects().length
    && [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())
    && !element.closest('.sr-only')).map(element => {
    const [text, back] = [light(getComputedStyle(element).color), light(ground(element))];
    return { text: (element.textContent ?? '').trim().slice(0, 24), size: parseFloat(getComputedStyle(element).fontSize),
      contrast: Math.round(((Math.max(text, back) + .05) / (Math.min(text, back) + .05)) * 10) / 10 };
  });
});
const box = async (page: Page, selector: string) => {
  const rect = await page.locator(selector).first().boundingBox();
  return { top: Math.round(rect!.y), bottom: Math.round(rect!.y + rect!.height), left: Math.round(rect!.x), right: Math.round(rect!.x + rect!.width),
    height: Math.round(rect!.height) };
};
const ground = (page: Page, name: string, role: 'link' | 'button' = 'link') =>
  page.getByRole('dialog').getByRole(role, { name }).evaluate(element => getComputedStyle(element).backgroundColor);
const DARK = 'rgb(38, 38, 38)';
const WHITE = 'rgb(255, 255, 255)';

for (const state of ['off', 'members', 'ready', 'connected', 'loading', 'failed'] as const) for (const width of [1280, 390]) {
  it(`${state} at ${width}px: a white dialog on which every line can be read, with the product's mark beside its name`, async () => {
    const { page, errors } = await open(state, width);
    try {
      if (shots) await page.screenshot({ path: `${shots}/${state}-${width}.png` });
      const dialog = page.getByRole('dialog');
      expect(await dialog.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(WHITE);
      const lines = await words(page);
      expect(lines.length).toBeGreaterThan(12);
      for (const line of lines) {
        expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
        expect(line.size, `"${line.text}" is too small`).toBeGreaterThanOrEqual(13);
      }
      // The mark: Shotviva's own picture, loaded, in the dialog's head and on the card behind it.
      for (const scope of [dialog.locator('header'), page.locator('main')]) {
        const mark = scope.locator('img[src="/integrations/shotviva.png"]').first();
        expect(await mark.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(192);
      }
      expect(await dialog.getByRole('heading', { name: 'Shotviva' }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(20);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

const VIEW = '?from=graylum&utm_source=graylum&utm_medium=integration&utm_campaign=shotviva&utm_content=view';
/** The links at the dialog's foot: their words, where they open, and what they carry. */
const foot = (page: Page) => page.getByRole('dialog').locator('footer a').evaluateAll(list =>
  list.map(link => [link.textContent, link.getAttribute('target'), new URL((link as HTMLAnchorElement).href).pathname, new URL((link as HTMLAnchorElement).href).search]));

it('the four states: what the connection says and offers, and which one action is the dark one; the foot is 去查看 alone', async () => {
  // Not open yet: nothing to press about the connection; 去查看 is the dialog's action.
  let { page } = await open('off', 1280);
  try {
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('未连接：连接暂未开放，可以先去 Shotviva 看看。')).toBeVisible();
    await ui(dialog.getByRole('button', { name: '连接 Shotviva' })).toHaveCount(0);
    expect(await ground(page, '去查看')).toBe(DARK);
    expect(await foot(page)).toEqual([['去查看', '_blank', '/zh', VIEW]]);
  } finally { await page.close(); }
  // Not a member: the membership page.
  ({ page } = await open('members', 1280));
  try {
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText('未连接：连接 Shotviva 是 Pro 和 Gold 会员的功能。')).toBeVisible();
    await ui(dialog.getByRole('link', { name: '查看会员' })).toHaveAttribute('href', '/app/profile?tab=subscription');
    await ui(dialog.getByRole('button', { name: '连接 Shotviva' })).toHaveCount(0);
    expect(await ground(page, '去查看')).toBe(DARK);
  } finally { await page.close(); }
  // Can connect: 连接 is the one dark action, so the link at the foot is plain.
  ({ page } = await open('ready', 1280));
  try {
    expect(await ground(page, '连接 Shotviva', 'button')).toBe(DARK);
    expect(await ground(page, '去查看')).toBe(WHITE);
    expect(await foot(page)).toEqual([['去查看', '_blank', '/zh', VIEW]]);
    // Owner 2026-11-13: no 去购买, anywhere on the page or in the dialog.
    await ui(page.getByText('去购买')).toHaveCount(0);
    expect(await page.locator('a[href*="pricing"], a[href*="utm_content=buy"]').count()).toBe(0);
  } finally { await page.close(); }
  // Connected: the balance, Shotviva's own top-up page, and 断开 asked twice.
  ({ page } = await open('connected', 1280));
  try {
    const dialog = page.getByRole('dialog');
    // Both kinds of credits, each by its name.
    await ui(dialog.locator('[data-connection=connected] p').first()).toHaveText('已连接：付费积分 12 · 免费积分 3');
    await ui(dialog.getByRole('link', { name: '去 Shotviva 充值' })).toHaveAttribute('href', BALANCE.topUpUrl);
    // The line between the two marks is joined, with a tick on it.
    await ui(dialog.locator('[data-linked=true] svg')).toBeVisible();
    await dialog.getByRole('button', { name: '断开' }).click();
    await ui(dialog.getByText('断开后，对话里就不能再用 Shotviva 出图了。')).toBeVisible();
    await dialog.getByRole('button', { name: '取消' }).click();
    await ui(dialog.getByText('断开后，对话里就不能再用 Shotviva 出图了。')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __disconnects?: number }).__disconnects ?? 0)).toBe(0);
    await dialog.getByRole('button', { name: '断开' }).click();
    if (shots) await page.screenshot({ path: `${shots}/connected-confirm-1280.png` });
    await dialog.getByRole('button', { name: '确认断开' }).click();
    expect(await page.evaluate(() => (window as unknown as { __disconnects?: number }).__disconnects)).toBe(1);
    // A disconnect that failed is said, in words that can be read.
    await ui(dialog.getByRole('alert')).toHaveText('断开没有成功，请稍后再试。');
    for (const line of await words(page)) expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
    expect(await ground(page, '去查看')).toBe(DARK);
    expect(await foot(page)).toEqual([['去查看', '_blank', '/zh', VIEW]]);
  } finally { await page.close(); }
}, 60000);

const TURN = ['coffee-phone', 'coffee-noir-bar'];
const USES: [string, string, string][] = [['菜品图', 'salad-phone', 'salad-forest-moss'], ['商品图', 'tote-phone', 'tote-promo'],
  ['房源图', 'room-phone', 'room-staged'], ['一键白底图', 'dress-phone', 'dress-white'], ['一键抠图', 'hair-phone', 'hair-cutout'],
  ['精准编辑图片文字', 'poster-before', 'poster-after']];
const SAMPLES = [...TURN, ...USES.flatMap(use => use.slice(1))];
/** Each sample picture's description, by its file's name: a picture not fetched yet has no address to be found by. */
const ALTS: Record<string, string> = Object.fromEntries((() => {
  const { showcase } = INTEGRATIONS[0]!;
  return [showcase!.before, showcase!.after, ...showcase!.uses.flatMap(use => [use.before, use.after])]
    .map(item => [item.src.split('/').pop()!.replace('.webp', ''), item.alt]);
})());
for (const width of [1280, 390, 360]) {
  it(`${width}px: the introduction is Shotviva's own pictures first: a phone photo and its result, then the same two for each of six uses`, async () => {
    const { page, errors } = await open('connected', width, width === 1280 ? 900 : 780);
    try {
      const dialog = page.getByRole('dialog');
      const picture = (name: string) => dialog.locator(`img[alt="${ALTS[name]}"]`);
      // Each picture: loaded once it is scrolled to, described in words, and no larger than a sharp screen needs.
      for (const name of SAMPLES) {
        await picture(name).scrollIntoViewIfNeeded();
        // (Until it is fetched its box holds one blank pixel.)
        await page.waitForFunction(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 1,
          await picture(name).elementHandle());
        const measured = await picture(name).evaluate((image: HTMLImageElement) => ({ natural: [image.naturalWidth, image.naturalHeight],
          shown: image.getBoundingClientRect().width, ratio: image.getBoundingClientRect().height / image.getBoundingClientRect().width,
          described: image.alt.length > 8 }));
        expect([measured.natural, measured.described], name).toEqual([TURN.includes(name) ? [336, 420] : [200, 250], true]);
        expect(Math.abs(measured.ratio - 1.25), name).toBeLessThan(.02);
        // Twice the shown size on a computer; on a phone, where it is shown a little smaller, never three times.
        expect(measured.natural[0]! / measured.shown, name).toBeGreaterThanOrEqual(1.9);
        expect(measured.natural[0]! / measured.shown, name).toBeLessThanOrEqual(width === 1280 ? 2.02 : 2.6);
      }
      const place = (name: string) => box(page, `[role=dialog] img[alt="${ALTS[name]}"]`);
      const column = await box(page, '[role=dialog] header + div');
      // 能做什么: the photo, an arrow, the result, side by side and the same size, each named under it.
      await dialog.getByRole('heading', { name: '能做什么' }).scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: `${shots}/pictures-turn-${width}.png` });
      const [before, after] = [await place('coffee-phone'), await place('coffee-noir-bar')];
      expect([after.top, after.height, after.right - after.left]).toEqual([before.top, before.height, before.right - before.left]);
      expect(after.left).toBeGreaterThan(before.right);
      expect(before.right - before.left, 'the two pictures are large enough to see').toBeGreaterThanOrEqual(140);
      const arrow = await box(page, '[role=dialog] figure + svg');
      expect([arrow.left >= before.right, arrow.right <= after.left, arrow.top > before.top, arrow.bottom < before.bottom]).toEqual([true, true, true, true]);
      expect(await dialog.locator('figure:has(+ svg) figcaption, svg + figure figcaption').allInnerTexts()).toEqual(['手机拍的照片', '选一个模板后']);
      // 什么时候适合用: one frame per use, the photo on the left and what came of it on the right, its name and a line under it.
      const cards = dialog.locator('ul li figure');
      expect(await cards.evaluateAll(list => list.map(card => [card.querySelector('b')?.textContent ?? '',
        ...[...card.querySelectorAll('img')].map(image => image.alt)]))).toEqual(USES.map(([label, photo, result]) => [label, ALTS[photo], ALTS[result]]));
      for (const [label, photo, result] of USES) {
        await dialog.getByText(label, { exact: true }).scrollIntoViewIfNeeded();
        const [left, right] = [await place(photo), await place(result)];
        expect([right.top, right.height], label).toEqual([left.top, left.height]);
        expect(Math.abs((right.right - right.left) - (left.right - left.left)), label).toBeLessThanOrEqual(1);
        expect(Math.abs(right.left - left.right - 2), label).toBeLessThanOrEqual(1);
        expect(left.right - left.left, label).toBeGreaterThanOrEqual(72);
        expect([left.left >= column.left, right.right <= column.right], label).toEqual([true, true]);
        const caption = await dialog.locator('ul li figure', { hasText: label }).locator('figcaption span').boundingBox();
        expect(caption!.y, label).toBeGreaterThan(left.bottom);
        // The line under a frame is one or two lines, not a paragraph.
        expect(caption!.height, label).toBeLessThanOrEqual(40);
      }
      // Three frames to a row on a computer, two on a phone.
      const tops = await Promise.all(USES.map(async use => (await place(use[1])).top));
      expect(new Set(tops).size).toBe(width === 1280 ? 2 : 3);
      // The cut-out stands on the squares that mean "no background"; the others have a ground of their own.
      expect(await picture('hair-cutout').evaluate(image => getComputedStyle(image).backgroundImage)).toContain('conic-gradient');
      expect(await picture('dress-white').evaluate(image => getComputedStyle(image).backgroundImage)).toBe('none');
      await dialog.getByText('精准编辑图片文字', { exact: true }).scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: `${shots}/pictures-uses-${width}.png` });
      for (const line of await words(page)) expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(await dialog.locator('header + div').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
}

for (const width of [390, 360]) {
  it(`${width}px: opening the sheet fetches only the pictures at hand; the rest are fetched as they are scrolled to, each once`, async () => {
    const { page, asked, errors } = await open('connected', width, 700);
    try {
      const middle = page.getByRole('dialog').locator('header + div');
      /** The sample pictures within `ahead` pixels of what the sheet shows of its middle. */
      const within = async (ahead: number) => {
        const alts = await middle.evaluate((scroller, margin) => {
          const frame = scroller.getBoundingClientRect();
          return [...scroller.querySelectorAll<HTMLImageElement>('figure img')].filter(image => {
            const rect = image.getBoundingClientRect();
            return rect.bottom > frame.top - margin && rect.top < frame.bottom + margin;
          }).map(image => image.alt);
        }, ahead);
        return SAMPLES.filter(name => alts.includes(ALTS[name]!));
      };
      await page.waitForTimeout(300);
      // On opening: what is shown and at most a row ahead of it; the kinds of use further down are not fetched.
      const first = [...asked];
      const [shown, ahead] = [await within(0), await within(161)];
      expect(first.length, `fetched on opening: ${first.join(', ')}`).toBeLessThanOrEqual(4);
      expect(shown.filter(name => !first.includes(name)), 'shown but not fetched').toEqual([]);
      expect(first.filter(name => !ahead.includes(name)), 'fetched but nowhere near').toEqual([]);
      for (const far of ['room-staged', 'dress-white', 'hair-cutout', 'poster-after']) expect(first).not.toContain(far);
      // Scrolling down brings in each of the others as it is reached, and none twice.
      const height = await middle.evaluate(scroller => scroller.scrollHeight);
      for (let top = 0; top <= height; top += 240) {
        await middle.evaluate((scroller, value) => { scroller.scrollTop = value; }, top);
        await page.waitForTimeout(60);
        for (const name of await within(0)) expect(asked, `in view at ${top}px`).toContain(name);
      }
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[role=dialog] figure img')]
        .every(image => image.complete && image.naturalWidth > 1));
      expect([...asked].sort()).toEqual([...SAMPLES].sort());
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

for (const width of [390, 360]) {
  it(`${width}px: a sheet on the bottom edge; its head and its link stay where they are while the middle scrolls`, async () => {
    const { page, errors } = await open('connected', width, 700);
    try {
      const dialog = await box(page, '[role=dialog]');
      expect([dialog.left, dialog.right, dialog.bottom]).toEqual([0, width, 700]);
      expect(dialog.top, 'the page behind stays visible above the sheet').toBeGreaterThanOrEqual(28);
      expect(await page.getByRole('dialog').evaluate(element => [getComputedStyle(element).borderTopLeftRadius,
        getComputedStyle(element).borderBottomLeftRadius])).toEqual(['24px', '0px']);
      const middle = page.getByRole('dialog').locator('header + div');
      expect(await middle.evaluate(element => element.scrollHeight - element.clientHeight), 'the introduction is longer than a phone').toBeGreaterThan(100);
      const before = [await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer')];
      await middle.evaluate(element => { element.scrollTop = element.scrollHeight; });
      if (shots) await page.screenshot({ path: `${shots}/connected-${width}-end.png` });
      expect([await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer')]).toEqual(before);
      // The link: one 48px button as wide as the sheet's content, clear of the bottom edge.
      expect(await foot(page)).toEqual([['去查看', '_blank', '/zh', VIEW]]);
      const view = await box(page, '[role=dialog] footer a');
      expect([view.left, view.right, view.height, 700 - view.bottom]).toEqual([16, width - 16, 48, 16]);
      // What is pressed inside the sheet is thumb-sized too.
      for (const name of ['去 Shotviva 充值', '断开']) {
        const target = await page.getByRole('dialog').getByText(name, { exact: true }).boundingBox();
        expect(target!.height, name).toBeGreaterThanOrEqual(44);
      }
      // The last line of the introduction ends above the foot, not under it.
      const last = await page.getByRole('dialog').locator('li').last().boundingBox();
      expect(Math.round(last!.y + last!.height)).toBeLessThanOrEqual(before[1]!.top);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

it('1280px on a short screen: a centred dialog no wider than 680px; the close button, the head and the foot stay while it scrolls', async () => {
  const { page, errors } = await open('ready', 1280, 620);
  try {
    const dialog = await box(page, '[role=dialog]');
    expect(dialog.right - dialog.left).toBe(680);
    expect(Math.abs((dialog.left + dialog.right) / 2 - 640)).toBeLessThanOrEqual(1);
    expect([dialog.top >= 16, dialog.bottom <= 604]).toEqual([true, true]);
    expect(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('18px');
    const middle = page.getByRole('dialog').locator('header + div');
    expect(await middle.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(100);
    const places = async () => [await box(page, '[role=dialog] header'), await box(page, '[role=dialog] footer'),
      await box(page, '[role=dialog] button:has(.sr-only)')];
    const before = await places();
    await middle.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await places()).toEqual(before);
    // A row is its name, then what it shows and says under it.
    const row = page.getByRole('dialog').locator('section').last();
    const [name, lines] = [await row.locator('h3').boundingBox(), await row.locator('ul').boundingBox()];
    expect(lines!.y).toBeGreaterThanOrEqual(name!.y + name!.height);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
