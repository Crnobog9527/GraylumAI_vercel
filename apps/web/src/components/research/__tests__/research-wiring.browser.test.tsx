/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, expect as ui, type Browser } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";

// The library evidence tab and the credit record's search details through the real tRPC client, against the
// RT-3b endpoint shapes (`research.evidence`, `research.toolCharges`) served by a fake API.
let browser: Browser;
let code: string;
let css: string;
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const entry = here("./__research_wiring_fixture__.js");

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve("vitest/package.json")).resolve("vite")).href);
  const [client, evidence, charges] = ["../../../trpc/client.ts", "../library-evidence.tsx", "../transaction-search-charges.tsx"]
    .map(path => JSON.stringify(here(path)));
  const bundle = await build({ configFile: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    oxc: { jsx: { runtime: "automatic" } },
    resolve: { alias: { "@": here("../../../") } },
    plugins: [{ name: "research-wiring-fixture", enforce: "pre",
      resolveId(id: string) { if (id === entry) return id; },
      load(id: string) {
        if (id !== entry) return;
        return `import React from 'react'; import {createRoot} from 'react-dom/client';
          import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
          import {httpLink} from '@trpc/client'; import {trpc} from ${client};
          import {LibraryEvidence} from ${evidence}; import {TransactionSearchCharges} from ${charges};
          const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
          const c=trpc.createClient({links:[httpLink({url:'http://research.test/api/trpc'})]});
          const e=React.createElement;
          createRoot(document.getElementById('root')).render(e(trpc.Provider,{client:c,queryClient},
            e(QueryClientProvider,{client:queryClient},e('main',{style:{maxWidth:760,margin:'0 auto',padding:16,display:'grid',gap:16}},
              e(TransactionSearchCharges,{transactionId:'11111111-1111-4111-8111-111111111111'}),
              e(LibraryEvidence)))));`;
      } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: "ResearchWiringTest", formats: ["iife"] } },
  });
  const output = (Array.isArray(bundle) ? bundle[0].output : bundle.output) as Array<{ type: string; code?: string; source?: string; fileName: string }>;
  code = output.find(item => item.type === "chunk")!.code!;
  css = output.filter(item => item.fileName.endsWith(".css")).map(item => String(item.source)).join("\n");
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  browser = await chromium.launch({ executablePath: existsSync(chrome) ? chrome : undefined, headless: true });
}, 30000);
afterAll(async () => { await browser?.close(); });

const row = (n: number) => ({
  operationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, toolName: "web_search", args: { query: `查询 ${n}` },
  state: "succeeded", fetchedAt: "2026-10-16T01:00:00Z", itemCount: 5, truncated: false, sources: [`https://site.test/${n}`],
  sessionId: "22222222-2222-4222-8222-222222222222", sessionTitle: "定位对话", createdAt: `2026-10-16T01:${String(n).padStart(2, "0")}:00Z`,
});

it("loads search details only when opened and pages through the evidence", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const errors: string[] = [];
  const calls: Array<{ path: string; input: unknown }> = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      const raw = url.searchParams.get("input");
      const input = raw ? JSON.parse(raw) : null;
      calls.push({ path: url.pathname, input });
      const data = url.pathname.endsWith("/research.toolCharges") ? { items: [
        { callId: "c1", toolName: "social_search", args: { platform: "douyin", keywords: ["职场穿搭"] }, source: "tool_usage", credits: "0.30" },
        { callId: "c2", toolName: "web_fetch", args: { url: "https://site.test/a" }, source: "tool_unknown", credits: null },
      ] } : input?.cursor ? { items: [row(1)], hasNextPage: false, nextCursor: null }
        : { items: [row(3), row(2)], hasNextPage: true, nextCursor: { createdAt: row(2).createdAt, operationId: row(2).operationId } };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ result: { data } }) });
    });
    await page.goto("http://research.test/");
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: code });

    const evidence = page.getByRole("region", { name: "搜索记录" });
    await ui(evidence.getByText("查询 3")).toBeVisible({ timeout: 5000 });
    expect(calls.some(call => call.path.endsWith("/research.toolCharges"))).toBe(false);
    await evidence.getByRole("button", { name: "加载更多" }).click();
    await ui(evidence.getByText("查询 1")).toBeVisible();
    await ui(evidence.getByRole("button", { name: "加载更多" })).toHaveCount(0);
    const evidenceCalls = calls.filter(call => call.path.endsWith("/research.evidence"));
    expect(evidenceCalls.map(call => call.input)).toEqual([
      { limit: 20 }, { limit: 20, cursor: { createdAt: row(2).createdAt, operationId: row(2).operationId } },
    ]);

    await page.getByRole("button", { name: "搜索明细" }).click();
    const charges = page.getByRole("region", { name: "本次回复里的搜索" });
    await ui(charges).toContainText("0.3 积分");
    await ui(charges).toContainText("结果待核，不收费");
    expect(calls.filter(call => call.path.endsWith("/research.toolCharges")).map(call => call.input))
      .toEqual([{ transactionId: "11111111-1111-4111-8111-111111111111" }]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30000);
