import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { db, resetSim, seed, signIn, watchPage } from './support';

/**
 * PUBLISH-MONITOR block D (#1716 acceptance step 10): two tabs show the same content pillars. One adds a pillar and saves; the other,
 * not reloaded, renames and saves. That save is built on the old list, so it is refused with words and the newer list is read
 * again: the first tab's pillar is never lost.
 */
test.beforeEach(resetSim);

/** The publish-monitor database fixtures' brand-account builder (pm_test.member), read as text: the file is a Node module. */
const fixtureSql = (() => {
  const text = readFileSync(resolve(__dirname, '../../../../../packages/db/tests/publish-monitor/fixtures.mjs'), 'utf8');
  const start = text.indexOf('export const fixtureSql = `') + 'export const fixtureSql = `'.length;
  return text.slice(start, text.indexOf('`;', start));
})();

/** A brand of carol's with an own connection and three saved pillars. */
async function brandWithPillars(actor: string) {
  const sql = db();
  await sql`insert into system_settings(key,value) values('publish_monitor_enabled','true'),('publish_monitor_review_enabled','true')
    on conflict(key) do update set value='true'`;
  const [plan] = await sql`update membership_plans set own_data_window_days=90 where level='gold' returning id`;
  if (!plan) await sql`insert into membership_plans(name,level,allow_fusion_review,allow_fusion_compare,library_storage_bytes,
    own_data_window_days,allow_weekly_auto_review,allow_benchmark_monitor) values('Sim Gold','gold',true,true,0,90,true,true)`;
  await sql.unsafe(fixtureSql);
  const [{ project }] = await sql<Array<{ project: string }>>`select pm_test.member(${actor}::uuid,'xiaohongshu')::text as project`;
  const [{ business }] = await sql<Array<{ business: string }>>`select business_id::text as business from opc_accounts
    where project_id=${project}::uuid`;
  await sql`insert into social_connections(actor_id,business_id,account_project_id,role,source,platform,status,consent_read)
    values(${actor}::uuid,${business}::uuid,${project}::uuid,'own','manual','xiaohongshu','connected',true)`;
  await sql`insert into social_coach_profiles(actor_id,business_id,pillars,pillars_source) values(${actor}::uuid,${business}::uuid,
    ${sql.json([{ key: 'p1', name: '读书笔记', definition: '读书笔记' }, { key: 'p2', name: '穿搭灵感', definition: '穿搭灵感' },
      { key: 'p3', name: '城市探店', definition: '城市探店' }])},'user')`;
  return business;
}

const savedNames = async (business: string) => ((await db()<Array<{ pillars: Array<{ name: string }> }>>`
  select pillars from social_coach_profiles where business_id=${business}::uuid`)[0]?.pillars ?? []).map(p => p.name);

/** Below 1360px the review settings (with the pillars) are folded above the reviews until opened; this window is 1280px wide. */
async function unfoldSettings(page: Page) {
  const fold = page.getByRole('button', { name: '复盘设置' });
  await expect(fold).toBeVisible({ timeout: 60_000 });
  if (await fold.getAttribute('aria-expanded') !== 'true') await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
}

async function openPillars(page: Page, evidence: (label: string) => Promise<void>) {
  await page.goto('/app/publish-monitor');
  // When the tab never shows (a CI run showed an unstyled "Graylum" and a blank page in the two tabs, with no stall of the server in that
  // test), say what the page asked for and got: failed requests, browser errors, the page text.
  await page.getByRole('tab', { name: '每周复盘' }).click().catch(async error => { await evidence('tab 每周复盘 never appeared'); throw error; });
  await unfoldSettings(page);
  await expect(page.getByLabel('内容方向 3 名称')).toHaveValue('城市探店', { timeout: 60_000 });
}

test('a save from a tab that missed another tab\'s save is refused and reads the newer list', async ({ page, context }) => {
  const carol = seed().users.carol;
  const business = await brandWithPillars(carol.id);
  await signIn(page, 'carol');
  const other = await context.newPage();
  const evidence = watchPage(page), evidenceOther = watchPage(other);
  await openPillars(page, evidence);
  await openPillars(other, evidenceOther);

  // Tab A adds a pillar and saves.
  await page.bringToFront();
  await page.getByRole('button', { name: '添加内容方向' }).click();
  await page.getByLabel('内容方向 4 名称').fill('冲突验收临时');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => savedNames(business)).toEqual(['读书笔记', '穿搭灵感', '城市探店', '冲突验收临时']);

  // Tab B, not reloaded, still shows the old list: it renames and saves.
  await other.bringToFront();
  await expect(other.getByLabel('内容方向 4 名称')).toHaveCount(0);
  await other.getByLabel('内容方向 1 名称').fill('旧窗口改名');
  // Answered at once: before the fix the database's refusal was re-run by PostgREST over and over and the save never came back.
  const answered = other.waitForResponse(r => r.url().includes('savePillars'), { timeout: 10_000 });
  await other.getByRole('button', { name: '保存', exact: true }).click();
  await answered;
  await expect(other.getByRole('alert').filter({ hasText: '刚在别处改过' })).toBeVisible();
  // The newer list is read again and the draft starts from it: tab A's pillar is there, the refused rename is not.
  await expect(other.getByLabel('内容方向 4 名称')).toHaveValue('冲突验收临时');
  await expect(other.getByLabel('内容方向 1 名称')).toHaveValue('读书笔记');
  expect(await savedNames(business)).toEqual(['读书笔记', '穿搭灵感', '城市探店', '冲突验收临时']);

  // After a reload both tabs show the list tab A saved.
  await other.reload();
  await other.getByRole('tab', { name: '每周复盘' }).click();
  await unfoldSettings(other);
  await expect(other.getByLabel('内容方向 4 名称')).toHaveValue('冲突验收临时', { timeout: 60_000 });
});

// Validation of #1882 (2026-11-12): one-click publishing's "去连接账号" links to /app/publish-monitor?tab=accounts. Followed inside the
// app (no reload) the page opened on 数据趋势, because it read the tab from window.location, which still held the page left behind.
test('a link inside the app that names a tab opens the data review page on that tab', async ({ page }) => {
  const carol = seed().users.carol;
  await brandWithPillars(carol.id);
  await signIn(page, 'carol');
  const push = (href: string) => page.evaluate(to => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push(to), href);
  await page.goto('/app/library');
  await expect(page.getByRole('link', { name: '数据复盘' }).first()).toBeVisible({ timeout: 60_000 });
  await push('/app/publish-monitor?tab=accounts');
  await expect(page).toHaveURL(/\/app\/publish-monitor\?tab=accounts$/, { timeout: 60_000 });
  await expect(page.getByRole('tab', { name: '账号' })).toHaveAttribute('data-state', 'active', { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: '我的账号' })).toBeVisible();
  // Another in-app link to the same page, naming another tab, is followed too; a plain link goes back to the first tab.
  await push('/app/publish-monitor?tab=import');
  await expect(page.getByRole('tab', { name: '表格导入' })).toHaveAttribute('data-state', 'active');
  await push('/app/publish-monitor');
  await expect(page.getByRole('tab', { name: '数据趋势' })).toHaveAttribute('data-state', 'active');
});
