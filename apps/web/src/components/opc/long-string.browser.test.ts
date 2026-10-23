/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The stylesheets as written (class names verbatim, no CSS-module hashing).
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = [
  read('./positioning-result.module.css'), read('./capture-checklist.module.css'),
  read('../chat/message-markdown.module.css'), read('../library/my-documents.module.css'),
].join('\n');
const URL200 = 'https://example.com/' + 'a1b2c3d4e5/'.repeat(17) + 'end';
let browser: Browser;

beforeAll(async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); }, 30000);

const page = `<main class="conversationPage" style="--bg-secondary:#f7f7f7;--bg-tertiary:#f4f4f5;--border-primary:#e8e8e8;font:15px sans-serif">
  <section aria-label="当前定位步骤"><aside class="mentorChat"><div role="log">
    <div data-message-role="user"><span>你 · 第 1 步</span><p style="white-space:pre-wrap">${URL200}</p></div>
    <div data-message-role="assistant"><div class="body" data-message-markdown>
      <p>参考 <a href="${URL200}">${URL200}</a> 和 <code>${URL200}</code></p>
      <div class="tableScroll"><table><thead><tr><th>链接</th></tr></thead><tbody><tr><td>${URL200}</td></tr></tbody></table></div>
      <pre id="code"><code>${URL200}${URL200}</code></pre></div></div>
  </div></aside></section>
  <div class="list" id="checklist"><details open class="step"><summary><span>${URL200}</span></summary>
    <div class="fields"><div class="field"><div class="fieldHead"><label>${URL200}</label></div><p class="hint">${URL200}</p></div></div></details></div>
  <div class="table" id="library"><div class="row"><div class="name"><div style="min-width:0"><span>${URL200}.pdf</span><small>2026-10-23</small></div></div></div></div>
</main>`;

for (const width of [375, 1440]) {
  it(`wraps a 200-character URL inside its container at ${width}px; code blocks keep scrolling`, async () => {
    const tab = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await tab.setContent(page);
      await tab.addStyleTag({ content: css });
      if (process.env.LONG_STRING_SHOT) await tab.screenshot({ path: `${process.env.LONG_STRING_SHOT}-${width}.png`, fullPage: true });
      const overflow = await tab.evaluate(() => {
        const spill = (root: Element) => [...root.querySelectorAll('*')].filter(node => {
          if (node.closest('pre, .tableScroll')) return false; // both scroll sideways by design
          const box = node.getBoundingClientRect(), edge = root.getBoundingClientRect();
          return box.width > 0 && (box.right > edge.right + 1 || box.left < edge.left - 1);
        }).map(node => node.tagName + ':' + (node.textContent ?? '').slice(0, 20));
        const log = document.querySelector('[role=log]')!;
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          log: spill(log), checklist: spill(document.getElementById('checklist')!), library: spill(document.getElementById('library')!),
          codeScrolls: document.getElementById('code')!.scrollWidth > document.getElementById('code')!.clientWidth,
        };
      });
      expect(overflow).toEqual({ page: 0, log: [], checklist: [], library: [], codeScrolls: true });
    } finally {
      await tab.close();
    }
  });
}
