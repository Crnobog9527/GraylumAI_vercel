/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { chromium, expect as ui } from '@playwright/test';
import { createRequire } from 'node:module';
const pg: typeof import('../../../../packages/api/node_modules/@types/pg') = createRequire(import.meta.url)('pg');
import { createClient } from '@supabase/supabase-js';
import { makePackage, makeWorkflow } from '../../../../packages/api/src/services/__tests__/fixtures/artifacts';
import { publishSkillPackage } from '../../../../packages/api/src/services/skills/publication';
import { opcService } from '../../../../packages/api/src/services/opc/service';

it('OPC: CONFIRM_DIALOG delayed cross-tab read and editing in the complete local page', async () => {
  const connectionString = process.env.V3_LOCAL_DB!;
  if (!connectionString?.startsWith('postgres://postgres@127.0.0.1:') || !connectionString.endsWith('/v3_disposable'))
    throw new Error('isolated workbench required');
  const sql = new pg.Client({ connectionString }); await sql.connect();
  const admin = createClient(process.env.V3_LOCAL_REST!, process.env.V3_LOCAL_SERVICE_JWT!, { auth: { persistSession: false } });
  const email = randomUUID() + '@example.test', password = 'Local-' + randomUUID() + '!';
  const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (made.error) throw made.error;
  const actor = made.data.user.id, owner = randomUUID(), model = randomUUID(), moduleId = randomUUID();
  const registration = 'opc-' + randomUUID(), pack = makePackage(), flow = makeWorkflow(6, true);
  flow.steps.forEach((step, index) => {
    step.title = index === 0 ? '需求确认' : '后续步骤' + index;
    step.information = [{ id: 'audience', title: '受众', required: true, profileKey: 'audience_' + index, elicitation: 'user_fact' }];
  });
  await sql.query("insert into profiles(id,email,role,credits) values($1,$2,'user',1000),($3,null,'admin',0)", [actor, email, owner]);
  await sql.query(`insert into credit_transactions(user_id,amount,type,ledger_type,reason_code,source_type,
    idempotency_key,balance_before,balance_after) values($1,1000,'addition','grant','opening_grant','system',$2,0,1000)`, [actor, randomUUID()]);
  await sql.query('insert into skills(id,skill_key,created_by) values($1,$2,$3)', [pack.id, registration, owner]);
  await sql.query(`insert into ai_models(id,name,model_id,provider,is_active,max_tokens,input_limit)
    values($1,'Local synthetic','opc-browser','fixture',true,1000,32000)`, [model]);
  await sql.query('insert into modules(id,title,skill_id,model_id,active) values($1,$2,$3,$4,true)', [moduleId, '本机确认回归', pack.id, model]);
  await publishSkillPackage(admin, owner, pack);
  await sql.query(`insert into artifact_workflows(id,module_id,skill_id,revision_id,workflow,label,enabled)
    values($1,$2,$3,$4,$5,$6,true)`, [registration, moduleId, pack.id, pack.revisionId, flow, '本机确认回归']);
  const user = createClient(process.env.V3_LOCAL_REST!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const login = await user.auth.signInWithPassword({ email, password }); if (login.error) throw login.error;
  const service = opcService(user, admin);
  const draft = await service.start({ requestId: randomUUID(), registration, mode: 'mentor', businessName: 'Synthetic regression' });
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  const path = '/positioning/' + draft.draftId, read = () => service.read(draft.draftId);
  let release = () => {};
  const counts = { information: 0, transition: 0, delayedReads: 0 };
  try {
    await page.goto(process.env.V3_LOCAL_APP + '/login?redirect=' + encodeURIComponent(path));
    await page.getByPlaceholder('name@example.com').fill(email);
    await page.getByPlaceholder('输入你的密码').fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).last().click();
    await page.waitForURL('**' + path);
    await ui(page.getByRole('textbox', { name: '给导师的回复', exact: true })).toBeEnabled();
    await page.locator('#step-0-audience').fill('社区3公里');
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe('社区3公里');
    const card = page.getByRole('region', { name: '本步确认', exact: true });
    const confirm = card.getByRole('button', { name: '没问题，进入下一步', exact: true });
    await ui(confirm).toBeEnabled();
    // Hold reads on the original page BEFORE the other tab saves. This makes the original cache deterministically old.
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/trpc/**', async route => {
      if (route.request().url().includes('opc.read')) { counts.delayedReads++; await held; }
      await route.continue();
    });
    const tab = await context.newPage();
    await tab.goto(process.env.V3_LOCAL_APP + path);
    await tab.locator('#step-0-audience').fill('社区2公里');
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe('社区2公里');
    await ui(tab.getByText('已保存 ✓', { exact: true })).toBeVisible();
    page.on('request', request => {
      if (request.url().includes('opc.information')) counts.information++;
      if (request.url().includes('workbench.execute')) counts.transition++;
    });
    await page.bringToFront();
    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      const region = document.querySelector('[aria-label="本步确认"]');
      const button = [...region!.querySelectorAll('button')].find(item => item.textContent?.includes('没问题'));
      button!.click();
    });
    const dialog = page.getByRole('dialog');
    await ui(dialog.getByText(/正在读取/)).toBeVisible();
    await ui(dialog.getByRole('button', { name: '确认这一步', exact: true })).toBeDisabled();
    await ui(dialog.getByText(/已刷新为最新/)).toHaveCount(0);
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/confirm-dialog-reading.png' });
    expect(counts.information).toBe(0); expect(counts.transition).toBe(0);
    release();
    await ui(dialog.getByLabel('核对：受众')).toHaveValue('社区2公里');
    await ui(dialog.getByRole('button', { name: '确认这一步', exact: true })).toBeEnabled();
    expect(counts.delayedReads).toBeGreaterThan(0);
    expect((await read()).snapshot.steps['step-0'].valid).toBe(false);
    expect(counts.information).toBe(0); expect(counts.transition).toBe(0);
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/confirm-dialog-fresh.png' });
    await page.unroute('**/api/trpc/**');
    // Real autosave, then another tab's write and a background refresh: keep this dialog's later edit.
    await dialog.getByLabel('核对：受众').fill('弹窗后来编辑1公里');
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe('弹窗后来编辑1公里');
    await tab.reload();
    await tab.locator('#step-0-audience').fill('外部后来修改4公里');
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe('外部后来修改4公里');
    await page.bringToFront();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await ui(card).toContainText('外部后来修改4公里');
    await ui(dialog.getByLabel('核对：受众')).toHaveValue('弹窗后来编辑1公里');
    const before = counts.information;
    await dialog.getByRole('button', { name: '确认这一步', exact: true }).click();
    await ui(dialog.getByLabel('核对：受众')).toHaveValue('外部后来修改4公里');
    expect(counts.information).toBe(before); expect(counts.transition).toBe(0);
    expect((await read()).snapshot.steps['step-0'].valid).toBe(false);
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/confirm-dialog-conflict.png' });
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT + '/confirmation-result.json', JSON.stringify({
      result: 'PASS', counts, delayedRead: true, zeroConfirmationBeforeReview: true,
      laterEditPreserved: true, concurrentConfirmationStopped: true, externalTransport: 'loopback only',
    }, null, 2));
  } finally { release(); await browser.close(); await sql.end(); }
}, 240000);
