/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The workspace stylesheet as written: its class names are used verbatim here, without CSS-module hashing.
const css = readFileSync(new URL('../../../components/opc/positioning-result.module.css', import.meta.url), 'utf8');
let browser: Browser;

beforeAll(async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

for (const width of [1920, 390]) {
  it(`gives the 本步小结 card its own background at ${width}px; ordinary replies stay transparent`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.setContent(`<main class="conversationPage" style="--bg-secondary:#f7f7f7;--border-primary:#e8e8e8">
        <section aria-label="当前定位步骤"><aside class="mentorChat"><div role="log">
          <div data-message-role="assistant" id="first">开场</div>
          <div data-message-role="assistant" id="ordinary">普通回复</div>
          <div data-message-role="assistant" data-step-summary="true" id="summary">本步小结</div>
        </div></aside></section></main>`);
      await page.addStyleTag({ content: css });
      const background = (id: string) => page.$eval('#' + id, node => getComputedStyle(node).backgroundColor);
      expect(await background('summary')).toBe('rgb(247, 247, 247)');
      expect(await background('ordinary')).not.toBe('rgb(247, 247, 247)');
    } finally {
      await page.close();
    }
  });
}
