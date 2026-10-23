/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { configuredReasoning } from '../__tests__/fixtures/runtimeReasoning';
import { pricingConfig } from '../__tests__/fixtures/runtimePricing';
import { createRequire } from 'node:module';
import type { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { opcService } from './service';
import { seedTestOpenRouterKey } from '../models/openRouterKey.testing';

// Reuse the existing runtime fixture without importing its legacy, excluded test
// cases into the API type-check graph. This narrow boundary is typed, not skipped.
const fixtureModule = './opc.integration';
const { mergedPositioningFixture, sql, admin } = await import(fixtureModule) as {
  mergedPositioningFixture: () => Promise<{
    actor: string; moduleId: string; registration: string; email: string; password: string;
    service: ReturnType<typeof opcService>;
  }>;
  sql: Client; admin: SupabaseClient;
};
// Browser dependency belongs to web. No API dependency or baseline exemption.
type Locator = {
  fill: (text: string) => Promise<void>; click: () => Promise<void>; last: () => Locator;
  count: () => Promise<number>; isVisible: () => Promise<boolean>;
  evaluate: <T>(fn: (node: HTMLElement) => T) => Promise<Awaited<T>>;
};
type Request = { url: () => string; postDataJSON: () => Record<string, unknown> };
type Route = { request: () => Request; continue: () => Promise<void>; abort: () => Promise<void>;
  fetch: (options: { url: string }) => Promise<unknown>;
  fulfill: (options: { response: unknown }) => Promise<void> };
type Page = {
  setDefaultTimeout: (ms: number) => void;
  on: (event: 'request', listener: (request: Request) => void) => void;
  addInitScript: (fn: () => void) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<Awaited<T>>;
  goto: (url: string) => Promise<unknown>; waitForURL: (url: string) => Promise<void>;
  reload: () => Promise<unknown>;
  getByPlaceholder: (text: string) => Locator; locator: (selector: string) => Locator;
  getByRole: (role: string, options: { name: string; exact?: boolean }) => Locator;
  getByText: (text: string, options: { exact: boolean }) => Locator;
};
type Context = {
  newPage: () => Promise<Page>; setOffline: (value: boolean) => Promise<void>;
  route: (pattern: string, handler: (route: Route) => Promise<void>) => Promise<void>;
};
const { chromium } = createRequire(new URL('../../../../../apps/web/package.json', import.meta.url))('@playwright/test') as {
  chromium: { launch: (options: { executablePath: string; headless: boolean }) => Promise<{
    newContext: (options: { viewport: { width: number; height: number }; serviceWorkers: 'block' }) => Promise<Context>;
    close: () => Promise<void>;
  }> };
};

const poll: typeof expect.poll = (callback, options) =>
  expect.poll(callback, { timeout: 30000, ...options });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Call = { index: number; id: string; stream: boolean; firstAt: number | null; finishedAt: number | null };
type Snapshot = { text: string; html: string; visible: boolean };
type Trace = {
  incremental: string[]; baseline: Snapshot | null; trusted: boolean; clicks: number;
  frames: number; differences: Snapshot[];
};
type TestWindow = Window & { stopTrace: Trace; finishStopTrace: () => Trace };

// Stop pressed while the attached organizer runs (staging 2026-10-23, #1272 A2): the page must show the saved
// turn once it completes, without a reload. Real local HTTP routes/executor/SQL; only the provider is synthetic.
it.runIf(process.env.V3_LOCAL_STAGING_HOST === 'true')('OPC: MENTOR_STREAM C2_STOP_ORGANIZER', async () => {
  const f = await mergedPositioningFixture();
  const mentorId = randomUUID(), organizerId = randomUUID(), key = 'SYNTHETIC_BROWSER_' + randomUUID();
  const policies = [[mentorId, 'qwen/qwen3.8-27b'], [organizerId, 'synthetic/browser-organizer']]
    .map(([modelId, model]) => ({
      multiplier: '1', modelId, model, provider: 'openrouter',
      account: 'openrouter-key:' + digest(key), protocol: 'openrouter-chat-v1',
      upperUsd: '0.02', inputLimit: 32000, outputLimit: 100,
      automaticRetry: false, hiddenTools: false, lookupSupported: true,
      providerLimits: { providerSlug: 'synthetic/fp8', contextTokens: 10000,
        promptUsdPerMillion: '2', completionUsdPerMillion: '0', requestUsd: '0' },
    }));
  for (const policy of policies) {
    const limits = policy.providerLimits;
    const config = { ...configuredReasoning(policy.model!), pricing: pricingConfig(
      policy.model!, limits.providerSlug, limits.promptUsdPerMillion, limits.completionUsdPerMillion,
    ).pricing };
    await sql.query(`insert into ai_models
      (id,name,model_id,provider,is_active,api_endpoint,max_tokens,input_limit,config,price_multiplier)
      values($1,'Synthetic C2 stop',$2,'openai','true','https://openrouter.ai/api/v1',1000,10000,$3,1)`,
    [policy.modelId, policy.model, JSON.stringify(config)]);
  }
  await seedTestOpenRouterKey(sql, key);
  await sql.query('update modules set model_id=$1 where id=$2', [mentorId, f.moduleId]);
  await sql.query(`insert into system_settings(key,value)
    values('v3_summary_model_id',$1),('v3_summary_max_tokens','128')
    on conflict(key) do update set value=excluded.value`, [JSON.stringify(organizerId)]);
  await sql.query(`insert into runtime_test_windows
    (id,enabled,actor_ids,call_policies,credits_per_usd,multiplier,max_cost_usd,max_calls,expires_at)
    values($1,true,$2,$3,1000,1,0.04,2,now()+interval '1 hour')`,
  [process.env.V3_RUNTIME_STAGING_WINDOW_ID, [f.actor], JSON.stringify(policies)]);
  const draft = await f.service.start({ requestId: randomUUID(), registration: f.registration,
    mode: 'mentor', businessName: 'Synthetic stop fixture' });
  const control = async (command?: { reset?: boolean; release?: number }): Promise<Call[]> => {
    const response = await fetch(process.env.V3_LOCAL_REST + '/__mentor_stream', {
      method: command ? 'POST' : 'GET', headers: { 'x-local-control': process.env.V3_LOCAL_CONTROL! },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    if (!response.ok) throw new Error('isolated provider control failed');
    return response.json();
  };
  await control({ reset: true });
  // Fresh ephemeral profile, never the user's browser or installed CDP bridge.
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let turns = 0;
  const stops: unknown[] = [];
  const timeline: Array<{ event: string; at: number; state?: string }> = [];
  const stamp = (event: string, state?: string) => timeline.push({ event, at: Date.now(), state });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'syntheticstaging.supabase.co') {
      const response = await route.fetch({ url: process.env.V3_LOCAL_REST + url.pathname + url.search });
      await route.fulfill({ response });
    } else if (['127.0.0.1', 'localhost'].includes(url.hostname)) await route.continue();
    else await route.abort();
  });
  page.on('request', request => {
    if (request.url().includes('opc.mentorTurnStream')) turns++;
    if (request.url().includes('runtime.cancel')) {
      const payload = request.postDataJSON();
      const input = (payload['0'] ?? payload) as Record<string, unknown>;
      stops.push(input.json ?? input);
    }
  });
  await page.addInitScript(() => {
    const win = window as unknown as TestWindow;
    const trace: Trace = { incremental: [], baseline: null, trusted: false, clicks: 0, frames: 0, differences: [] };
    win.stopTrace = trace;
    const sample = (): Snapshot => {
      const node = document.querySelector<HTMLElement>('[data-message-role="assistant"] [data-message-markdown]');
      const rect = node?.getBoundingClientRect();
      return { text: node?.innerText ?? '', html: node?.innerHTML ?? '', visible: !!rect?.width && !!rect.height };
    };
    const observe = () => {
      const value = sample();
      if (!trace.baseline) {
        if (value.text && trace.incremental.at(-1) !== value.text) trace.incremental.push(value.text);
      } else if (value.text !== trace.baseline.text || value.html !== trace.baseline.html || !value.visible) {
        trace.differences.push(value);
      }
    };
    const observer = new MutationObserver(observe);
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    let frame = 0;
    const tick = () => { if (trace.baseline) { trace.frames++; observe(); } frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element) || event.target.closest('button')?.textContent !== '停止') return;
      trace.clicks++; trace.trusted = event.isTrusted; trace.baseline = sample();
    }, true);
    win.finishStopTrace = () => { observer.disconnect(); cancelAnimationFrame(frame); observe(); return trace; };
  });
  try {
    const path = '/app/positioning/' + draft.draftId;
    await page.goto(process.env.V3_LOCAL_APP + '/login?redirect=' + encodeURIComponent(path));
    await page.getByPlaceholder('name@example.com').fill(f.email);
    await page.getByPlaceholder('输入你的密码').fill(f.password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL('**' + path);
    await poll(async () => (await control()).length).toBe(1);
    await poll(() => page.evaluate(() => (window as unknown as TestWindow).stopTrace.incremental.length))
      .toBeGreaterThanOrEqual(2);
    const rows = (await sql.query('select id,payload,result,billing_run_id from runtime_executions where actor_id=$1',
      [f.actor])).rows;
    expect(rows).toHaveLength(1);
    const execution = rows[0];
    expect(execution.payload).toMatchObject({ nativeOutput: 'native-output-v1', providerRequestFormat: 'agent-turn-v5-stream' });
    expect(execution.result).toBeNull();
    expect((await control())[0]).toMatchObject({ stream: true, finishedAt: null });
    const read = async () => {
      const result = await admin.rpc('runtime_execution', {
        p_actor_id: f.actor, p_execution_id: execution.id, p_action: 'read', p_result: null,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data;
    };
    // The primary reply finishes; the organizer call is then held.
    await control({ release: 1 });
    await poll(async () => (await control()).length).toBe(2);
    expect((await control())[1]).toMatchObject({ stream: false, finishedAt: null });
    await poll(() => page.getByText('正文已返回，正在整理待核对信息…', { exact: true }).isVisible()).toBe(true);
    stamp('organizer-running');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await poll(() => stops.length).toBe(1);
    await poll(async () => (await read()).pausedReason).toBe('user_stop');
    stamp('stop-recorded', (await read()).state);
    // Staging: the organizer answered about 35 s after the stop; keep it running that long, with one brief offline blip.
    await context.setOffline(true);
    await new Promise(resolve => setTimeout(resolve, 2000));
    await context.setOffline(false);
    await new Promise(resolve => setTimeout(resolve, 38000));
    stamp('before-release', (await read()).state);
    await control({ release: 2 });
    stamp('organizer-released');
    await poll(async () => (await read()).state).toBe('completed');
    stamp('server-completed');
    // Without a reload the page leaves the saving and organizer states and shows the saved turn within seconds.
    await poll(async () => (await page.getByText('已停止，正在保存已显示的内容…', { exact: true }).isVisible())
      || (await page.getByText('正文已返回，正在整理待核对信息…', { exact: true }).isVisible()), { timeout: 10000 }).toBe(false);
    stamp('page-settled');
    expect(await page.getByRole('button', { name: '停止', exact: true }).count()).toBe(0);
    expect(await page.getByText('回复暂未完成', { exact: false }).count()).toBe(0);
    expect((await read()).result).toMatchObject({ stopped: true });
    expect(turns).toBe(1);
    expect(stops).toHaveLength(1);
    await writeFile(process.env.V3_WORKBENCH_OUTPUT + '/c2-stop-organizer.json', JSON.stringify({ executionId: execution.id, timeline }, null, 2));
    console.info('C2_STOP_ORGANIZER_PASS', JSON.stringify({ timeline }));
  } finally {
    try { for (const call of await control()) if (call.finishedAt === null) await control({ release: call.index }); }
    finally { await browser.close(); }
  }
}, 300000);
