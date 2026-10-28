import { expect, test } from './support/fixtures';
import { runtimeBox, sendRuntimeMessage, startFreeChat, waitForRuntimeTurn } from './support/freeChat';

/**
 * Journey 4: deleting a long conversation. Closing an account is not automated: it is left to manual acceptance
 * (Owner 2026-10-28: the human-check key stays as it is).
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
