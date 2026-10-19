/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect as ui, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";

// The three research blocks (calls, keyword and candidate cards) and the benchmark table in a real browser,
// driven with local mock data at desktop and phone widths. Set RESEARCH_SHOTS_DIR to keep screenshots locally.
let browser: Browser;
let code: string;
let css: string;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const entry = here("./__research_cards_fixture__.js");

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve("vitest/package.json")).resolve("vite")).href);
  const modules = Object.fromEntries(["../research-call-list.tsx", "../keyword-card.tsx", "../candidate-card.tsx",
    "../benchmark-table.tsx", "../search-charges.tsx", "../evidence-list.tsx", "./fixtures.ts"].map(path => [path, JSON.stringify(here(path))]));
  const bundle = await build({ configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": here("../../../") } },
    plugins: [{ name: "research-cards-fixture", enforce: "pre",
      resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {ResearchCallList} from ${modules["../research-call-list.tsx"]};
          import {KeywordCardView} from ${modules["../keyword-card.tsx"]};
          import {CandidateCardView} from ${modules["../candidate-card.tsx"]};
          import {BenchmarkTable} from ${modules["../benchmark-table.tsx"]};
          import {SearchCharges} from ${modules["../search-charges.tsx"]};
          import {EvidenceList} from ${modules["../evidence-list.tsx"]};
          import * as f from ${modules["./fixtures.ts"]};
          window.submissions=[];
          const confirm=card=>async submission=>{window.submissions.push({card:card.cardId,submission});
            await new Promise(r=>setTimeout(r,50));
            const items=card.kind==='keywords'?window.keywordItems(submission,card)
              :card.options.filter(o=>submission.selected.includes(o.id)).map(({label,selectable,...rest})=>rest);
            return {cardId:card.cardId,confirmationId:'c-'+card.cardId,kind:card.kind,items};};
          window.keywordItems=(s,card)=>[...card.options.filter(o=>s.selected.includes(o.id)).map(o=>(s.edits||{})[o.id]??o.text),
            ...(s.additions||[])];
          const e=React.createElement;
          createRoot(document.getElementById('root')).render(e('main',{style:{maxWidth:760,margin:'0 auto',padding:16,display:'grid',gap:16}},
            e(ResearchCallList,{calls:f.CALLS}),
            e(KeywordCardView,{card:f.KEYWORD_CARD,onConfirm:confirm(f.KEYWORD_CARD)}),
            e(CandidateCardView,{card:f.CANDIDATE_CARD,onConfirm:confirm(f.CANDIDATE_CARD)}),
            e(CandidateCardView,{card:f.FOLLOW_UP_CARD,onConfirm:confirm(f.FOLLOW_UP_CARD)}),
            e(BenchmarkTable,{rows:f.ROWS,now:f.NOW,onRefresh:async row=>{window.refreshes=(window.refreshes||0)+1;
              await new Promise(r=>setTimeout(r,50));if(row.account==='sample_3')throw new Error('RESEARCH_REFRESH_INVALID');}}),
            e(SearchCharges,{charges:f.CHARGES}),
            e(EvidenceList,{entries:f.EVIDENCE})));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: "ResearchCardsTest", formats: ["iife"] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; code?: string; source?: string; fileName: string }>;
  code = output.find(item => item.type === "chunk")!.code!;
  css = output.filter(item => item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

async function open(width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://research.test/");
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: code });
  await ui(page.getByRole("region", { name: "对标表" })).toBeVisible({ timeout: 5000 });
  return { page, errors };
}

const shot = async (page: Page, name: string) => {
  const dir = process.env.RESEARCH_SHOTS_DIR;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
};

for (const width of [1440, 375]) {
  it(`works at ${width}px: calls, keyword card, candidate cards and the table`, async () => {
    const { page, errors } = await open(width);
    try {
      const calls = page.getByRole("list", { name: "搜索记录" }).getByRole("listitem");
      await ui(calls).toHaveCount(5);
      await ui(calls.nth(2)).toContainText("待核");
      await ui(calls.nth(3)).toContainText("这次没查到");
      await ui(calls.nth(4)).toContainText("正在搜");
      await shot(page, `research-${width}-before`);

      const keywords = page.getByRole("region", { name: "关键词选择" });
      await keywords.getByRole("checkbox").nth(1).uncheck();
      await keywords.getByRole("textbox", { name: "关键词文字" }).nth(2).fill("胶囊衣橱搭配");
      await keywords.getByRole("textbox", { name: "补充关键词" }).fill("西装外套");
      await keywords.getByRole("button", { name: "添加" }).click();
      await keywords.getByRole("button", { name: "确认关键词" }).click();
      const keywordEcho = page.getByRole("region", { name: "关键词" });
      await ui(keywordEcho).toContainText("胶囊衣橱搭配");
      await ui(keywordEcho.getByRole("textbox")).toHaveCount(0);
      await ui(keywordEcho.getByRole("button")).toHaveCount(0);

      const candidates = page.getByRole("region", { name: "对标候选账号" });
      await ui(candidates.getByRole("group", { name: "候选账号" }).getByRole("checkbox")).toHaveCount(10);
      for (const box of await candidates.getByRole("group", { name: "头部账号" }).getByRole("checkbox").all()) {
        await ui(box).toBeDisabled();
      }
      await ui(candidates.getByText("只作参考").first()).toBeVisible();
      await ui(candidates.getByText("AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。")).toBeVisible();
      const confirmPick = candidates.getByRole("button", { name: "确认选择" });
      await candidates.getByText("通勤衣橱研究所").click();
      await candidates.getByText("小个子穿搭日记").click();
      await ui(confirmPick).toBeDisabled();
      await candidates.getByText("职场新人穿什么").click();
      await ui(confirmPick).toBeEnabled();
      await confirmPick.click();
      await ui(page.getByRole("region", { name: "对标候选账号" })).toContainText("已确认");

      const followUp = page.getByRole("region", { name: "补选对标账号" });
      await ui(followUp.getByText("至少选 1 个，最多 2 个", { exact: false })).toBeVisible();

      const table = page.getByRole("region", { name: "对标表" });
      await ui(table.getByText("这次没查到").first()).toBeVisible();
      await ui(table).toContainText("可以照着学 3 个");
      await table.getByRole("button", { name: "刷新 sample_1 的数据" }).click();
      await ui(table.getByRole("button", { name: "刷新 sample_1 的数据" })).toHaveText("已申请刷新");
      await ui(table.getByRole("button", { name: "刷新 sample_1 的数据" })).toBeDisabled();
      await table.getByRole("button", { name: "刷新 sample_3 的数据" }).click();
      await ui(table.getByRole("alert")).toHaveText("这个账号现在不能刷新，可能正在读取中，请稍后再试。");
      expect(await page.evaluate(() => (window as unknown as { refreshes: number }).refreshes)).toBe(2);

      const charges = page.getByRole("region", { name: "本次回复里的搜索" });
      await ui(charges.getByRole("listitem")).toHaveCount(5);
      await ui(charges).toContainText("0.3 积分");
      await ui(charges).toContainText("结果待核，不收费");
      const evidence = page.getByRole("region", { name: "搜索记录" });
      await ui(evidence.locator("li[class*=evidence]")).toHaveCount(3);
      await ui(evidence.getByRole("link", { name: /javascript/ })).toHaveCount(0);
      await ui(evidence).toContainText("另有 1 个来源");
      const shown = (await page.textContent("main")) ?? "";
      for (const word of ["TikHub", "Parallel", "Firecrawl", "tikhub", "美元"]) expect(shown).not.toContain(word);
      await shot(page, `research-${width}-after`);

      const submissions = await page.evaluate(() => (window as unknown as { submissions: unknown[] }).submissions);
      expect(submissions).toEqual([
        { card: "33333333-3333-4333-8333-333333333333",
          submission: { selected: ["k1", "k3"], edits: { k3: "胶囊衣橱搭配" }, additions: ["西装外套"] } },
        { card: "44444444-4444-4444-8444-444444444444", submission: { selected: ["c1", "c2", "c3"] } },
      ]);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);
}
