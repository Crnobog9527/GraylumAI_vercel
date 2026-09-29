/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { it, expect } from 'vitest';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const requireWeb = createRequire(new URL('../../../../../apps/web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test') as typeof import('../../../../../apps/web/node_modules/@playwright/test');

it('B01: model selection and credential-free HTTP responses after revocation', async () => {
  const app = process.env.V3_LOCAL_APP!, rest = process.env.V3_LOCAL_REST!;
  const connectionString = process.env.V3_LOCAL_DB!;
  if (!app?.startsWith('http://127.0.0.1:') || !rest?.startsWith('http://127.0.0.1:') ||
    !connectionString?.endsWith('/v3_disposable')) throw new Error('Local workbench required');
  const sql = new pg.Client({ connectionString });
  const db = createClient(rest, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const client = createClient(rest, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const modelId = randomUUID(), secret = randomUUID() + randomUUID();
  const email = `${randomUUID()}@example.invalid`, password = randomUUID() + '!';
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  });
  try {
    await sql.connect();
    expect((await sql.query("select has_column_privilege('authenticated','ai_models','api_key','SELECT') as allowed"))
      .rows[0].allowed).toBe(false);
    const created = await db.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    await sql.query("insert into profiles(id,email,nickname,role,credits) values($1,$2,'B01 fixture','admin',10000)", [userId,email]);
    await sql.query("insert into system_settings(key,value) values('chat_show_model_selector','true') on conflict(key) do update set value='true'");
    await sql.query(`insert into ai_models(id,name,model_id,api_key,is_active,input_token_cost,output_token_cost)
      values($1,'B01 synthetic selection','synthetic/b01',$2,'true',1000000,1000000)`, [modelId, secret]);
    const login = await client.auth.signInWithPassword({ email, password });
    expect(login.error).toBeNull();
    expect((await client.from('ai_models').select('api_key').eq('id', modelId)).error?.code).toBe('42501');
    expect((await client.from('ai_models').select('id,name').eq('id', modelId)).data?.[0].id).toBe(modelId);
    expect((await db.from('ai_models').select('api_key').eq('id', modelId).single()).data?.api_key).toBe(secret);
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)
        ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const ready = page.waitForResponse(r => r.url().includes('settings.getSystemSettings') && r.ok());
    await page.goto(app + '/login?redirect=/chat');
    await ready;
    await page.getByPlaceholder('name@example.com').fill(email);
    await page.getByPlaceholder('输入你的密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL(u => u.pathname === '/chat', { timeout: 90000 });
    const selector = page.getByTestId('chat-model-selector-trigger');
    await selector.click();
    await page.getByTestId(`chat-model-option-${modelId}`).click();
    expect(await selector.textContent()).toContain('B01 synthetic selection');
    for (const [name, input] of [
      ['model.getActiveModels', undefined], ['ai.getAvailableModels', undefined],
      ['ai.estimateCost', { message: 'synthetic estimate', modelId }],
      ['settings.getSummaryModels', undefined], ['model.getAdminModelsDashboard', undefined],
    ] as const) {
      const response = await page.request.get(app + '/api/trpc/' + name +
        (input ? '?input=' + encodeURIComponent(JSON.stringify(input)) : ''));
      expect(response.status()).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('api_key');
      expect(body).not.toContain(secret.slice(0, 20));
      expect(body).not.toContain(secret.slice(-20));
      if (name === 'ai.estimateCost') expect(body).toContain('synthetic/b01');
    }
    const update = await page.request.post(app + '/api/trpc/model.updateModel', {
      data: { id: modelId, name: 'B01 updated selection' },
    });
    expect(update.status()).toBe(200);
    expect(await update.text()).not.toContain('api_key');
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/b01-model-selection.png' });
    await context.close();
  } finally {
    await browser.close();
    await sql.end();
  }
}, 180000);
