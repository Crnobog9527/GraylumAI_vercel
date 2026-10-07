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

it('OPC: UI_COVERAGE long card scroll and mobile edit in complete local page', async () => {
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
    const long = Array.from({ length: 60 }, (_, i) => `受众${i + 1}`).join('\n');
    await page.locator('#step-0-audience').fill(long);
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe(long);
    await ui(confirm).toBeEnabled();
    const list = card.locator('ul');
    const measurements: unknown[] = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await ui(list).toContainText('受众60');
      const geometry = await list.evaluate(element => ({
        client: element.clientHeight, scroll: element.scrollHeight,
        overflow: getComputedStyle(element).overflowY, viewport: innerHeight,
      }));
      expect(geometry.scroll).toBeGreaterThan(geometry.client);
      expect(geometry.client).toBeLessThanOrEqual(viewport.height * .4 + 2);
      expect(geometry.overflow).toBe('auto');
      await list.hover();
      await page.mouse.wheel(0, 10000);
      await expect.poll(() => list.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2)).toBe(true);
      const atBottom = await list.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2);
      expect(atBottom).toBe(true);
      expect(await list.innerText()).toContain('受众60');
      measurements.push({ viewport, geometry, scrolledToEnd: atBottom });
      await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + `/long-card-${viewport.width}.png` });
    }
    const panel = page.getByRole('complementary', { name: '当前成果' });
    await ui(panel).toBeHidden();
    await card.getByRole('button', { name: '我要改', exact: true }).click();
    await ui(panel).toBeVisible();
    const field = page.locator('#step-0-audience');
    await ui(field).toBeFocused();
    await ui(panel.locator('[data-highlight=true]')).toHaveCount(1);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/mobile-edit-focus.png' });
    await field.fill('手机修改后的合成受众');
    await expect.poll(async () => (await read()).information['step-0'].values.audience?.value, { timeout: 30000 }).toBe('手机修改后的合成受众');
    await ui(panel.getByText('已保存 ✓', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '收起成果面板' }).click();
    await ui(panel).toBeHidden();
    await ui(card).toContainText('手机修改后的合成受众');
    await ui(card.locator('[data-look=true]')).toHaveCount(0);
    await page.screenshot({ path: process.env.V3_WORKBENCH_OUTPUT + '/mobile-saved-card.png' });
    writeFileSync(process.env.V3_WORKBENCH_OUTPUT + '/ui-coverage-result.json', JSON.stringify({
      result: 'PASS', measurements, mobilePanelBounds: box,
      mobileEdit: { opens: true, focused: true, highlighted: true, saves: true, cardUpdated: true },
      externalTransport: 'loopback only', limitation: 'synthetic hand-filled field, desktop Chromium mobile viewport; no device keyboard or paid acceptance',
    }, null, 2));
  } finally { await browser.close(); await sql.end(); }
}, 240000);
