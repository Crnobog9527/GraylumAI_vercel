import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { db, resetSim, seed, signIn } from './support';

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

async function openPillars(page: Page) {
  await page.goto('/app/publish-monitor');
  await page.getByRole('tab', { name: '每周复盘' }).click();
  await expect(page.getByLabel('内容方向 3 名称')).toHaveValue('城市探店', { timeout: 60_000 });
}

test('a save from a tab that missed another tab\'s save is refused and reads the newer list', async ({ page, context }) => {
  const carol = seed().users.carol;
  const business = await brandWithPillars(carol.id);
  await signIn(page, 'carol');
  const other = await context.newPage();
  await openPillars(page);
  await openPillars(other);

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
  await expect(other.getByLabel('内容方向 4 名称')).toHaveValue('冲突验收临时', { timeout: 60_000 });
});
