/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * The home page's backdrop (backdrop-j.module.css, drawn by MotionJ) in Chrome. Its three pools of light used to glide with
 * left/top when the module in the middle of the screen changed. Every frame of that glide was a layout shift of an element larger
 * than the screen: scrolling the home page from top to bottom scored a CLS of 1.34 on a desktop and 2.36 on a phone (staging,
 * 2026-11-11), all of it from the pools. They glide with `translate` now, which is not a layout shift.
 *
 * The stylesheet is loaded as written (its class names are plain here), with MotionJ's markup. Two versions are run: the file,
 * and the file without its `@supports (width: 1cqw)` block, which is what a browser without container units uses (the old
 * left/top placement). Both must put every pool at the same point in every module; only the first must glide without shifts.
 */
vi.setConfig({ testTimeout: 60_000 });

const file = fileURLToPath(new URL('./backdrop-j.module.css', import.meta.url));
const css = readFileSync(file, 'utf8');
const SUPPORTS_BLOCK = /@supports \(width: 1cqw\) \{[\s\S]*?\n\}\n/;
const withoutContainerUnits = css.replace(SUPPORTS_BLOCK, '');
const POOLS = ['gold', 'cool', 'paper'] as const;
type Pool = (typeof POOLS)[number];
type Point = { x: number; y: number };

/** Where each rule puts each pool: percent of the backdrop's width and height, as written in the stylesheet. */
const placements = new Map<string, Point>();
for (const match of css.matchAll(/^(?:\[data-zone='(\w+)'\] |\.backdrop )\.(gold|cool|paper) \{ --pool-x: (-?[\d.]+); --pool-y: (-?[\d.]+);/gm)) {
  placements.set(`${match[1] ?? 'hero'}:${match[2]}`, { x: Number(match[3]), y: Number(match[4]) });
}
const ZONES = ['hero', 'voice', 'takeover', 'work', 'compare', 'price', 'faq', 'final'];

const document = (sheet: string) => `<!doctype html><html><head><style>html,body{margin:0}${sheet}</style></head><body>
  <div id="root" data-zone="hero">
    <div class="backdrop" aria-hidden="true"><div class="grid"></div>
      <span class="pool paper"></span><span class="pool cool"></span><span class="pool gold"></span></div>
    <main style="position:relative;height:300vh"></main>
  </div>
  <script>
    window.poolShifts = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) {
      if ((entry.sources || []).some(source => source.node && source.node.classList && source.node.classList.contains('pool'))) window.poolShifts.push(entry.value);
    } }).observe({ type: 'layout-shift', buffered: true });
  </script></body></html>`;

let browser: Browser;
beforeAll(async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
});
afterAll(async () => { await browser?.close(); });

async function open(sheet: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  await page.setContent(document(sheet));
  // The first placement (from opacity 0, no glide to wait for) and the observer's first entries.
  await page.waitForTimeout(400);
  return page;
}

/** Moves the backdrop's light to a module, as MotionJ does, and waits for the 1.6 s glide to end. */
async function enter(page: Page, zone: string) {
  await page.evaluate(next => { window.document.getElementById('root')!.dataset.zone = next; }, zone);
  await page.waitForTimeout(2000);
}

/** Each pool's centre, in percent of the backdrop's width and height. */
const centres = (page: Page) => page.evaluate(names => {
  const box = window.document.querySelector('.backdrop')!.getBoundingClientRect();
  return Object.fromEntries(names.map(name => {
    const rect = window.document.querySelector(`.pool.${name}`)!.getBoundingClientRect();
    return [name, { x: ((rect.left + rect.width / 2 - box.left) / box.width) * 100, y: ((rect.top + rect.height / 2 - box.top) / box.height) * 100 }];
  }));
}, [...POOLS]) as Promise<Record<Pool, Point>>;

const poolShifts = (page: Page) => page.evaluate(() => (window as unknown as { poolShifts: number[] }).poolShifts.splice(0));

describe('the stylesheet as written', () => {
  it('names a place for every pool in every module, and only there', () => {
    expect([...placements.keys()].sort()).toEqual(ZONES.flatMap(zone => POOLS.map(pool => `${zone}:${pool}`)).sort());
    // left/top belong to the one fallback rule and to the rule that anchors the pool; no module moves a pool with them.
    expect(css.match(/\b(?:left|top): -?[\d.]+%/g)).toBeNull();
    expect(SUPPORTS_BLOCK.test(css)).toBe(true);
    const supported = css.match(SUPPORTS_BLOCK)![0];
    expect(supported).toContain('container-type: size');
    expect(supported).toMatch(/transition: translate /);
    expect(supported).not.toMatch(/transition:[^;]*\b(?:left|top)\b/);
  });
});

describe.each([
  ['a desktop', { width: 1350, height: 940 }],
  ['a 360px phone', { width: 360, height: 780 }],
])('the backdrop on %s', (_name, viewport) => {
  it('glides its pools from module to module without one layout shift, and ends where the stylesheet says', async () => {
    const page = await open(css, viewport);
    try {
      await poolShifts(page);
      for (const zone of ['takeover', 'price', 'hero']) {
        await enter(page, zone);
        const at = await centres(page);
        for (const pool of POOLS) {
          const want = placements.get(`${zone}:${pool}`)!;
          expect(at[pool].x, `${zone} ${pool} x`).toBeCloseTo(want.x, 0);
          expect(at[pool].y, `${zone} ${pool} y`).toBeCloseTo(want.y, 0);
        }
      }
      expect(await poolShifts(page)).toEqual([]);
    } finally { await page.close(); }
  });

  it('without container units puts the pools at the same points (the old left/top glide, which does shift)', async () => {
    const page = await open(withoutContainerUnits, viewport);
    try {
      await poolShifts(page);
      for (const zone of ['takeover', 'price', 'hero']) {
        await enter(page, zone);
        const at = await centres(page);
        for (const pool of POOLS) {
          const want = placements.get(`${zone}:${pool}`)!;
          expect(at[pool].x, `${zone} ${pool} x`).toBeCloseTo(want.x, 0);
          expect(at[pool].y, `${zone} ${pool} y`).toBeCloseTo(want.y, 0);
        }
      }
      // This is the measurement the first test relies on: the same page, gliding with left/top, is seen shifting.
      expect((await poolShifts(page)).length).toBeGreaterThan(0);
    } finally { await page.close(); }
  });
});
