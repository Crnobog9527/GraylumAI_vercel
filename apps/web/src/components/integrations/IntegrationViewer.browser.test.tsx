/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// A sample picture of a product's introduction, opened large (Owner 2026-11-13: "现在集成介绍这个弹窗里面的这些图片，要支持用户
// 点击以后看大图。"), in a real browser with the app's CSS and a stand-in for the server. Measured: each of the fourteen pictures
// is a button with a name; pressing one opens the photo and its result large, side by side on a computer and one across the
// screen on a phone; the ways from one to the other and from pair to pair; the ways out (the button, a press outside, Esc, a
// drag down on a phone) and where focus goes; that the large files are fetched only then, and that nothing moves while they
// come. INTEGRATION_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs';
import { chromium, expect as ui, type Browser, type Locator, type Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { INTEGRATIONS, showcasePairs } from '@/lib/integrations/catalog';
import { buildIntegrationsPage, openIntroduction } from './integrations-browser-harness';

let browser: Browser;
let html = '';
const shots = process.env.INTEGRATION_SHOTS;
const PAIRS = showcasePairs(INTEGRATIONS[0]!);
const file = (src: string) => src.split('/').pop()!.replace('.webp', '');
/** A pair by its title, with its two pictures' descriptions and file names. */
const pair = (title: string) => {
  const found = PAIRS.find(item => item.title === title)!;
  return { ...found, alts: found.sides.map(side => side.alt), files: found.sides.map(side => file(side.src)) };
};

beforeAll(async () => {
  html = await buildIntegrationsPage();
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

const introduction = (page: Page) => page.locator('[role=dialog]', { has: page.locator('header img[src="/integrations/shotviva.png"]') });
/** The button a sample picture is, in the introduction. */
const thumb = (page: Page, alt: string) => introduction(page).getByRole('button', { name: `看大图：${alt}`, includeHidden: true });
/** The large view (while it is open the introduction behind it is hidden from assistive technology, so this is the one dialog). */
const viewer = (page: Page, title: string) => page.getByRole('dialog', { name: title });
const rect = async (target: Locator) => {
  const box = (await target.boundingBox())!;
  return { left: Math.round(box.x), top: Math.round(box.y), right: Math.round(box.x + box.width), bottom: Math.round(box.y + box.height),
    width: Math.round(box.width), height: Math.round(box.height) };
};
const settled = (page: Page) => page.waitForFunction(() => [...document.querySelectorAll('[role=dialog]')]
  .every(dialog => dialog.getAnimations().every(animation => animation.playState === 'finished')));
const arrived = (view: Locator) => ui(view.locator('figure img[data-arrived=true]')).toHaveCount(2);
const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? '');
/** The words of the large view against what is behind them (WCAG 2.1; 4.5 is the floor). */
const contrasts = (view: Locator) => view.evaluate(dialog => {
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
  return [...dialog.querySelectorAll<HTMLElement>('*')].filter(element => element.getClientRects().length && !element.closest('.sr-only')
    && [...element.childNodes].some(node => node.nodeType === 3 && (node.textContent ?? '').trim())).map(element => {
    const [text, back] = [light(getComputedStyle(element).color), light(ground(element))];
    return { text: (element.textContent ?? '').trim().slice(0, 16), contrast: Math.round(((Math.max(text, back) + .05) / (Math.min(text, back) + .05)) * 10) / 10 };
  });
});

it('each of the fourteen sample pictures is a button named 看大图 and what the picture is; the small files are the ones they were', async () => {
  const { page, errors } = await openIntroduction(browser, html, 'ready', 1280);
  try {
    const names = await introduction(page).locator('figure button').evaluateAll(list => list.map(button => [button.getAttribute('aria-label'),
      button.getAttribute('type'), button.querySelectorAll('img').length, getComputedStyle(button).cursor]));
    expect(names).toEqual(PAIRS.flatMap(item => item.sides.map(side => [`看大图：${side.alt}`, 'button', 1, 'zoom-in'])));
    // Reached with the keyboard: Tab comes to a picture, and Enter opens it.
    await thumb(page, pair('能做什么').alts[0]!).focus();
    expect(await focusedName(page)).toBe(`看大图：${pair('能做什么').alts[0]}`);
    await page.keyboard.press('Enter');
    await ui(viewer(page, '能做什么')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('1280px: a picture opens its pair large, side by side, with its words; the arrows go from pair to pair; the large files are fetched only then', async () => {
  const { page, errors, asked, askedLarge } = await openIntroduction(browser, html, 'connected', 1280);
  try {
    const salad = pair('菜品图');
    await thumb(page, salad.alts[1]!).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const small = [...asked];
    // Looking at the introduction, however far it is scrolled, fetches no large file.
    expect(askedLarge).toEqual([]);
    await thumb(page, salad.alts[1]!).click();
    const view = viewer(page, '菜品图');
    await ui(view).toBeVisible();
    await settled(page);
    await arrived(view);
    if (shots) await page.screenshot({ path: `${shots}/viewer-1280.png` });
    // This pair's two files and no other; the small files are not fetched again.
    expect(askedLarge).toEqual(salad.files);
    expect(asked).toEqual(small);
    // Its words: what the pair is and one line; each picture named; where it stands among the seven.
    await ui(view.getByRole('heading', { name: '菜品图' })).toBeVisible();
    await ui(view.getByText(salad.note)).toBeVisible();
    expect(await view.locator('figcaption').allInnerTexts()).toEqual(['原图', '成品']);
    await ui(view.locator('nav')).toContainText('2 / 7');
    // The two pictures: side by side, the same size, far larger than the small ones, inside the window, 4:5.
    const [photo, result] = [await rect(view.getByAltText(salad.alts[0]!)), await rect(view.getByAltText(salad.alts[1]!))];
    expect([result.top, result.width, result.height]).toEqual([photo.top, photo.width, photo.height]);
    expect(result.left).toBeGreaterThan(photo.right);
    expect(photo.width).toBeGreaterThanOrEqual(380);
    expect(Math.abs(photo.height / photo.width - 1.25)).toBeLessThan(.02);
    const panel = await rect(view);
    expect([panel.top >= 16, panel.bottom <= 764, Math.abs((panel.left + panel.right) / 2 - 640) <= 1]).toEqual([true, true, true]);
    // The photo is the file exported at 960×1200; this template's result exists only smaller (see the PR), and fills the same box.
    expect(await view.locator('figure img').evaluateAll(list => list.map(image => (image as HTMLImageElement).naturalWidth))).toEqual([960, 381]);
    // Focus is inside the large view, and the introduction behind it is out of reach.
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog][aria-labelledby]') && document.activeElement !== document.body)).toBe(true);
    expect(await view.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
    for (const line of await contrasts(view)) expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
    // On to the next pair by its arrow, and to the one after by the keyboard; back the same way.
    await view.getByRole('button', { name: '下一组' }).click();
    await ui(viewer(page, '商品图')).toBeVisible();
    await ui(viewer(page, '商品图').locator('nav')).toContainText('3 / 7');
    await arrived(viewer(page, '商品图'));
    expect(askedLarge).toEqual([...salad.files, ...pair('商品图').files]);
    await page.keyboard.press('ArrowRight');
    await ui(viewer(page, '房源图')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const first = viewer(page, '能做什么');
    await ui(first).toBeVisible();
    await ui(first.locator('nav')).toContainText('1 / 7');
    expect(await first.locator('figcaption').allInnerTexts()).toEqual(['手机拍的照片', '选一个模板后']);
    await ui(first.getByText('每个模板都保留你拍的主体，只换光线、场景或画风。')).toBeVisible();
    // There is nothing before the first pair, nor after the last.
    await ui(first.getByRole('button', { name: '上一组' })).toBeDisabled();
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('ArrowRight');
    const last = viewer(page, '精准编辑图片文字');
    await ui(last.locator('nav')).toContainText('7 / 7');
    await ui(last.getByRole('button', { name: '下一组' })).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await ui(last).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60000);

it('the ways out: Esc, a press outside and the button each close the large view alone, and focus goes back to the picture that opened it', async () => {
  const { page, errors } = await openIntroduction(browser, html, 'ready', 1280);
  try {
    const room = pair('房源图');
    const opener = thumb(page, room.alts[0]!);
    const ways: [string, (view: Locator) => Promise<void>][] = [
      ['Esc', async () => { await page.keyboard.press('Escape'); }],
      ['a press outside', async () => { await page.mouse.click(12, 12); }],
      ['the button', async view => { await view.getByRole('button', { name: '关闭' }).click(); }],
    ];
    for (const [name, leave] of ways) {
      await opener.click();
      const view = viewer(page, '房源图');
      await ui(view, name).toBeVisible();
      // The layer starts listening for a press outside a tick after it appears (so the press that opened it is not one):
      // leave as a person does, once it is there and focus has come into it.
      await expect.poll(() => view.evaluate(dialog => dialog.contains(document.activeElement)), { message: name }).toBe(true);
      await page.waitForTimeout(50);
      await leave(view);
      await ui(view, name).toHaveCount(0);
      // The introduction is still open behind it, and can be used again.
      await ui(introduction(page), name).toBeVisible();
      await ui(introduction(page).getByRole('link', { name: '去查看' }), name).toBeVisible();
      await expect.poll(() => focusedName(page), { message: name }).toBe(`看大图：${room.alts[0]}`);
    }
    // Esc once more closes the introduction itself, as before.
    await page.keyboard.press('Escape');
    await ui(page.locator('[role=dialog]')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

it('while a large file is on its way its box is already the picture\'s size, holding the small picture; nothing moves when it arrives', async () => {
  const { page, errors } = await openIntroduction(browser, html, 'ready', 1280, 780, { slowLarge: 700 });
  try {
    const dress = pair('一键白底图');
    await thumb(page, dress.alts[0]!).click();
    const view = viewer(page, '一键白底图');
    await ui(view).toBeVisible();
    await settled(page);
    const waiting = view.getByAltText(dress.alts[0]!);
    const before = { state: await waiting.getAttribute('data-arrived'), box: await rect(waiting), panel: await rect(view),
      ground: await waiting.evaluate(image => getComputedStyle(image).backgroundImage) };
    expect(before.state).toBe('false');
    expect(before.ground).toContain('/integrations/shotviva/dress-phone.webp');
    expect(before.ground).not.toContain('/large/');
    expect(before.box.width).toBeGreaterThanOrEqual(380);
    await arrived(view);
    expect([await rect(waiting), await rect(view)]).toEqual([before.box, before.panel]);
    expect(await waiting.evaluate(image => getComputedStyle(image).backgroundImage)).toBe('none');
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

for (const width of [390, 360]) {
  it(`${width}px: a sheet with one picture across the screen; the two names and a swipe change it; a drag down closes it`, async () => {
    const { page, errors, askedLarge } = await openIntroduction(browser, html, 'ready', width, 780, { touch: true });
    try {
      const hair = pair('一键抠图');
      await thumb(page, hair.alts[1]!).scrollIntoViewIfNeeded();
      // The result was the half pressed, so the result is the picture across the screen.
      await thumb(page, hair.alts[1]!).click();
      const view = viewer(page, '一键抠图');
      await ui(view).toBeVisible();
      await settled(page);
      await arrived(view);
      expect(askedLarge).toEqual(hair.files);
      const sheet = await rect(view);
      expect([sheet.left, sheet.right, sheet.bottom]).toEqual([0, width, 780]);
      expect(sheet.top, 'the introduction stays visible above the sheet').toBeGreaterThanOrEqual(28);
      expect(await view.evaluate(dialog => [getComputedStyle(dialog).borderTopLeftRadius, getComputedStyle(dialog).borderBottomLeftRadius])).toEqual(['24px', '0px']);
      const across = async () => {
        const boxes = await Promise.all(hair.alts.map(alt => rect(view.getByAltText(alt))));
        return boxes.map(box => box.left >= 0 && box.right <= width);
      };
      const pressed = () => view.getByRole('group', { name: '看哪一张' }).getByRole('button').evaluateAll(list =>
        list.map(button => [button.textContent, button.getAttribute('aria-pressed')]));
      expect(await across()).toEqual([false, true]);
      expect(await pressed()).toEqual([['原图', 'false'], ['成品', 'true']]);
      const picture = await rect(view.getByAltText(hair.alts[1]!));
      expect(picture.width, 'the picture is as wide as the sheet allows').toBeGreaterThanOrEqual(width - 34);
      expect(Math.abs(picture.height / picture.width - 1.25)).toBeLessThan(.02);
      // The result has no background: once it has arrived it stands on the squares.
      expect(await view.getByAltText(hair.alts[1]!).evaluate(image => getComputedStyle(image).backgroundImage)).toContain('conic-gradient');
      if (shots) await page.screenshot({ path: `${shots}/viewer-${width}.png` });
      // The other by its name.
      await view.getByRole('button', { name: '原图' }).click();
      await expect.poll(across).toEqual([true, false]);
      expect(await pressed()).toEqual([['原图', 'true'], ['成品', 'false']]);
      // And back by a swipe sideways: the names follow where the swipe came to rest.
      await view.locator('figure').first().locator('..').evaluate(strip => { strip.scrollTo({ left: strip.scrollWidth, behavior: 'smooth' }); });
      await expect.poll(pressed).toEqual([['原图', 'false'], ['成品', 'true']]);
      expect(await across()).toEqual([false, true]);
      // What is pressed is thumb-sized; the page does not scroll sideways.
      for (const name of ['上一组', '下一组', '关闭']) expect((await rect(view.getByRole('button', { name }))).height, name).toBeGreaterThanOrEqual(44);
      for (const name of ['原图', '成品']) expect((await rect(view.getByRole('button', { name }))).height, name).toBeGreaterThanOrEqual(36);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      for (const line of await contrasts(view)) expect(line.contrast, `"${line.text}" cannot be read`).toBeGreaterThanOrEqual(4.5);
      // The next pair, by its arrow, opens on its photo.
      await view.getByRole('button', { name: '下一组' }).click();
      const poster = viewer(page, '精准编辑图片文字');
      await ui(poster).toBeVisible();
      await expect.poll(() => poster.getByRole('button', { name: '原图' }).getAttribute('aria-pressed')).toBe('true');
      // A finger dragging the sheet: a little way and it stays; far enough down and it closes.
      const drag = (dialog: Locator, to: number) => dialog.evaluate((element, distance) => {
        const touch = (y: number) => new Touch({ identifier: 1, target: element, clientX: 180, clientY: y });
        const fire = (type: string, y: number) => element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
          touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)] }));
        fire('touchstart', 300);
        for (let y = 300; y <= 300 + distance; y += 20) fire('touchmove', y);
        fire('touchend', 300 + distance);
      }, to);
      await drag(poster, 50);
      await page.waitForTimeout(250);
      await ui(poster).toBeVisible();
      expect((await rect(poster)).bottom).toBe(780);
      await drag(poster, 160);
      await ui(poster).toHaveCount(0);
      await ui(introduction(page)).toBeVisible();
      // Focus is back on the picture that opened the large view.
      expect(await focusedName(page)).toBe(`看大图：${hair.alts[1]}`);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
}

it('390px on a short screen: the picture gives way to the screen\'s height, and the sheet\'s head and arrows are all on it', async () => {
  const { page, errors } = await openIntroduction(browser, html, 'ready', 390, 620, { touch: true });
  try {
    const coffee = pair('能做什么');
    await thumb(page, coffee.alts[0]!).scrollIntoViewIfNeeded();
    await thumb(page, coffee.alts[0]!).click();
    const view = viewer(page, '能做什么');
    await ui(view).toBeVisible();
    await settled(page);
    const [sheet, picture] = [await rect(view), await rect(view.getByAltText(coffee.alts[0]!))];
    expect([sheet.bottom, sheet.top >= 28]).toEqual([620, true]);
    expect(Math.abs(picture.height / picture.width - 1.25)).toBeLessThan(.02);
    for (const part of [view.getByRole('heading', { name: '能做什么' }), view.getByRole('button', { name: '关闭' }), view.getByRole('button', { name: '下一组' })]) {
      const box = await rect(part);
      expect([box.top >= sheet.top, box.bottom <= 620]).toEqual([true, true]);
    }
    expect(picture.top).toBeGreaterThan((await rect(view.getByRole('button', { name: '手机拍的照片' }))).bottom);
    expect(picture.bottom).toBeLessThan((await rect(view.getByRole('button', { name: '下一组' }))).top + 1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);
