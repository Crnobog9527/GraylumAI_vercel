import { expect, test } from './support/fixtures';
import { credentialsFor } from './support/config';
import { runtimeBox, sendRuntimeMessage, startFreeChat, waitForRuntimeTurn } from './support/freeChat';

/**
 * Journey 4: deleting a long conversation, and closing an account.
 * The long conversation is built through the product with one-word replies (about 20 short model turns, a fraction of a
 * cent each): the runtime tables carry frozen payloads and billing links that a raw INSERT cannot fake safely.
 */
test('journey 4b: a 20-turn free conversation is deleted; the row goes and the old link does not break', async ({ openAs, meter }) => {
  test.setTimeout(25 * 60_000);
  const { page } = await openAs('pro');
  const session = await startFreeChat(page, '只回复数字 1，不要其他文字。');
  await waitForRuntimeTurn(page);
  for (let turn = 2; turn <= 20; turn += 1) {
    await sendRuntimeMessage(page, `只回复数字 ${turn}，不要其他文字。`, turn % 5 === 0 ? meter : undefined, `long chat turn ${turn}`);
  }
  await expect(runtimeBox(page)).toBeVisible();
  await meter.checkpoint('journey 4b: 20 turns');

  const link = page.locator(`a[href*="session=${session}"]`).first();
  await expect(link).toBeVisible();
  const row = link.locator('xpath=ancestor::*[.//button[contains(@aria-label,"的更多操作")]][1]');
  await row.getByRole('button', { name: /的更多操作$/ }).click();
  await page.getByRole('menuitem', { name: '删除对话' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('删除后无法恢复');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(`a[href*="session=${session}"]`)).toHaveCount(0);

  // The old link goes back to the start page; nothing blank, no error screen.
  await page.goto(`/app/runtime?session=${session}`);
  await page.waitForURL(/\/app\/positioning$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: '今天，想推进什么？' })).toBeVisible();
  await meter.finishJourney('journey 4b: delete long conversation');
});

/**
 * The account used here is closed for good, so the seed script (scripts/e2e-core-path/seed.mjs) recreates it before
 * every run. Closing needs the password again and the human-check widget; the staging site must use the test key.
 */
test('journey 4c: closing an account signs it out and the account can no longer log in', async ({ openAs, browser }) => {
  test.setTimeout(5 * 60_000);
  const { email, password } = credentialsFor('erase');
  test.skip(!email || !password, 'needs CORE_E2E_ERASE_EMAIL / CORE_E2E_ERASE_PASSWORD');
  const { page } = await openAs('erase');
  await page.goto('/app/profile?tab=security');
  await page.getByRole('button', { name: '注销账号' }).click();
  const dialog = page.getByRole('dialog', { name: '注销账号' });
  await expect(dialog).toContainText('确认后账号立即关闭，不能再登录或使用');
  await dialog.getByRole('button', { name: '继续' }).click();
  await dialog.getByLabel('当前密码').fill(password);
  await dialog.getByRole('button', { name: '验证身份' }).click();
  await expect(dialog).toContainText('这是最后一步，确认后立即生效。', { timeout: 60_000 });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '确认注销' }).click();
  await expect(dialog).toContainText('账号已注销', { timeout: 90_000 });
  await dialog.getByRole('button', { name: '返回首页' }).click();
  await page.waitForURL(url => url.pathname === '/', { timeout: 30_000 });

  const fresh = await browser.newContext();
  const login = await fresh.newPage();
  await login.goto('/login');
  await login.locator('#email, input[type="email"], input[name="email"]').fill(email);
  await login.locator('#password, input[type="password"], input[name="password"]').fill(password);
  await login.locator('button[type="submit"]').click();
  await expect(login.getByText('该账号已注销或已被停用，无法登录')).toBeVisible({ timeout: 30_000 });
  await fresh.close();
});
