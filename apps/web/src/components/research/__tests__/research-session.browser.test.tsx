/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect as ui, type Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";

// RT-5 phase 2: what the positioning conversation mounts (the session's cards, the benchmark table and the live
// search rows of a turn) through the real tRPC client, against the `research.cards` / `research.confirmCard` /
// `research.benchmarks` shapes served by a fake API.
let browser: Browser;
let code: string;
let css: string;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const entry = here("./__research_session_fixture__.js");
const SESSION = "22222222-2222-4222-8222-222222222222";
const KEYWORD_CARD = "33333333-3333-4333-8333-333333333333";
const CANDIDATE_CARD = "44444444-4444-4444-8444-444444444444";
const CONFIRMATION = "77777777-7777-4777-8777-777777777777";

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve("vitest/package.json")).resolve("vite")).href);
  const [client, session, list, model] = ["../../../trpc/client.ts", "../research-session.tsx", "../research-call-list.tsx",
    "../research-session-model.ts"].map(path => JSON.stringify(here(path)));
  const bundle = await build({ configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": here("../../../") } },
    plugins: [{ name: "research-session-fixture", enforce: "pre",
      resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${client};
          import {ResearchSessionPanel,useResearchCalls} from ${session}; import {ResearchCallList} from ${list};
          import {researchConfirmedInput} from ${model};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const c=trpc.createClient({links:[httpLink({url:'http://research.test/api/trpc'})]});
          const e=React.createElement;
          window.sent=[];
          function Conversation(){
            const research=useResearchCalls(${JSON.stringify(SESSION)});
            const [settled,setSettled]=React.useState(0);
            window.emit=event=>research.observe('exec-1',event);
            window.settle=()=>setSettled(value=>value+1);
            return e('main',{style:{maxWidth:760,margin:'0 auto',padding:16,display:'grid',gap:16}},
              e(ResearchCallList,{calls:research.of('exec-1')}),
              e(ResearchSessionPanel,{sessionId:${JSON.stringify(SESSION)},disabled:false,settledTurns:settled,
                onConfirmed:confirmation=>window.sent.push(researchConfirmedInput(confirmation))}));
          }
          createRoot(document.getElementById('root')).render(e(trpc.Provider,{client:c,queryClient},
            e(QueryClientProvider,{client:queryClient},e(Conversation))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: "ResearchSessionTest", formats: ["iife"] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; code?: string; source?: string; fileName: string }>;
  code = output.find(item => item.type === "chunk")!.code!;
  css = output.filter(item => item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

const option = (n: number) => ({ id: `c${n}`, platform: "douyin", account: `sample_${n}`, evidenceRef: `ev${n}#1`,
  label: `样例账号 ${n}`, selectable: true });
const benchmark = (account: string, extra: Record<string, unknown> = {}) => ({
  platform: "douyin", account, followers: 38200, medianViews: 52000, engagementRate: 0.0634, postsPerWeek: 4.2,
  lastPublishedAt: "2026-10-13T10:00:00Z", postsAnalyzed: 24, category: "imitable", qualified: true, excluded: null,
  fetchedAt: "2026-10-15T08:00:00Z", ...extra,
});

for (const width of [375, 1440]) {
  it(`confirms a card once, sends the choice on and shows the session's benchmark table at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors: string[] = [];
    const calls: Array<{ method: string; path: string; input: unknown }> = [];
    let keywordsConfirmed = false;
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        const raw = request.method() === "POST" ? request.postData() : url.searchParams.get("input");
        const input = raw ? JSON.parse(raw) : null;
        calls.push({ method: request.method(), path: url.pathname, input });
        let data: unknown = {};
        if (url.pathname.endsWith("/research.cards")) data = { items: [
          { cardId: KEYWORD_CARD, kind: "keywords", minSelect: 1, maxSelect: 5,
            options: [{ id: "k1", text: "职场穿搭" }, { id: "k2", text: "通勤穿搭" }],
            confirmationId: keywordsConfirmed ? CONFIRMATION : null, items: keywordsConfirmed ? ["职场穿搭"] : null },
          { cardId: CANDIDATE_CARD, kind: "candidates", minSelect: 3, maxSelect: 5,
            options: [option(1), option(2), option(3), { ...option(9), id: "h1", selectable: false }],
            confirmationId: "88888888-8888-4888-8888-888888888888",
            items: [1, 2, 3].map(n => ({ id: `c${n}`, platform: "douyin", account: `sample_${n}`, evidenceRef: `ev${n}#1` })) },
        ] };
        else if (url.pathname.endsWith("/research.confirmCard")) {
          keywordsConfirmed = true;
          data = { cardId: KEYWORD_CARD, confirmationId: CONFIRMATION, kind: "keywords", items: ["职场穿搭"] };
        } else if (url.pathname.endsWith("/research.benchmarks")) data = { items: [
          benchmark("sample_1"),
          benchmark("sample_2", { medianViews: null, engagementRate: null, fetchedAt: "2026-10-16T09:30:00Z" }),
          benchmark("sample_head", { followers: 2_350_000, category: "head_reference", qualified: false }),
        ] };
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) });
      });
      await page.goto("http://research.test/");
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: code });

      // Cards: the confirmed candidate card is a read-only echo; the open keyword card is answered once.
      const keywords = page.getByRole("region", { name: "关键词选择" });
      await ui(keywords).toBeVisible({ timeout: 5000 });
      await ui(page.getByText("sample_3")).toBeVisible();
      await ui(page.getByRole("button", { name: "确认选择" })).toHaveCount(0);
      await keywords.getByRole("checkbox", { name: "使用关键词 通勤穿搭" }).uncheck();
      await keywords.getByRole("button", { name: "确认关键词" }).click();
      await ui(page.getByRole("button", { name: "确认关键词" })).toHaveCount(0);
      const confirms = calls.filter(call => call.path.endsWith("/research.confirmCard"));
      expect(confirms).toEqual([{ method: "POST", path: "/api/trpc/research.confirmCard",
        input: { cardId: KEYWORD_CARD, selected: ["k1"] } }]);
      await ui.poll(() => page.evaluate(() => (window as unknown as { sent: string[] }).sent)).toEqual(["我确认了这些关键词：职场穿搭"]);
      // The stored cards are read again after the confirmation.
      await ui.poll(() => calls.filter(call => call.path.endsWith("/research.cards")).length).toBeGreaterThan(1);
      expect(calls.filter(call => call.path.endsWith("/research.cards")).map(call => call.input))
        .toContainEqual({ sessionId: SESSION });

      // Benchmark table: missing numbers stay missing, the report's minimum is spelled out.
      const table = page.getByRole("region", { name: "对标表" });
      await ui(table).toContainText("3 个账号 · 合格 2 个");
      await ui(table).toContainText("缺失 / 未取到");
      await ui(table).toContainText("头部参考");
      await ui(table).toContainText("生成定位报告需要至少 3 个合格的对标账号，目前 2 个");
      await ui(table).toContainText("取数时间：");
      expect(await table.getByRole("button", { name: /刷新/ }).count()).toBe(0);

      // Live search rows of a turn: running, then settled with the user's credits.
      const before = calls.filter(call => call.path.endsWith("/research.benchmarks")).length;
      const call = { type: "research_call", callId: "call-1", toolName: "benchmark_fetch", args: {}, query: "sample_1",
        platform: "douyin", dataKind: "account_posts" };
      await page.evaluate(event => (window as unknown as { emit: (event: unknown) => void }).emit(event), { ...call, state: "running" });
      const rows = page.getByRole("list", { name: "搜索记录" });
      await ui(rows).toContainText("正在搜");
      await page.evaluate(event => (window as unknown as { emit: (event: unknown) => void }).emit(event),
        { ...call, state: "succeeded", evidenceId: "ev1", credits: "0.30" });
      await ui(rows).toContainText("成功");
      await ui(rows).toContainText("扣 0.3 积分");
      // The row is committed only as the turn finishes: no re-read on the call's own event, one once the turn is saved.
      await page.waitForTimeout(300);
      expect(calls.filter(item => item.path.endsWith("/research.benchmarks")).length).toBe(before);
      const cardReads = calls.filter(item => item.path.endsWith("/research.cards")).length;
      await page.evaluate(() => (window as unknown as { settle: () => void }).settle());
      await ui.poll(() => calls.filter(item => item.path.endsWith("/research.benchmarks")).length).toBe(before + 1);
      await ui.poll(() => calls.filter(item => item.path.endsWith("/research.cards")).length).toBe(cardReads + 1);

      const text = await page.locator("main").innerText();
      for (const word of ["TikHub", "tikhub", "Parallel", "Firecrawl", "美元", "$"]) expect(text).not.toContain(word);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      if (process.env.RESEARCH_SESSION_SHOTS)
        await page.screenshot({ path: `${process.env.RESEARCH_SESSION_SHOTS}/research-session-${width}.png`, fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30000);
}
