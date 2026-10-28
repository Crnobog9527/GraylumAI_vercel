import { expect, test } from './support/fixtures';
import { startFreeChat, waitForRuntimeTurn, runtimeBox } from './support/freeChat';
import { readCredits } from './support/ui';

/** Journey 5: compare two models. Both columns answer; the total charge is exactly the sum of the column charges. */
test('journey 5: two models answer and the total equals the sum of the columns', async ({ openAs, meter }) => {
  test.setTimeout(10 * 60_000);
  const { page } = await openAs('gold');
  await page.goto('/app/profile');
  const before = await readCredits(page);

  await startFreeChat(page, '用一句话说明小红书和抖音的内容分发区别。');
  await waitForRuntimeTurn(page);

  await runtimeBox(page).click();
  await page.keyboard.insertText('用两句话说明为什么新账号要先做定位。');
  await page.getByRole('button', { name: '多模型对比' }).click();
  const picker = page.getByRole('dialog', { name: '多模型对比' });
  await expect(picker).toBeVisible();
  const boxes = picker.getByRole('checkbox');
  const total = await boxes.count();
  expect(total, 'at least two comparable models are configured').toBeGreaterThanOrEqual(2);
  // Exactly two models: untick everything beyond the first two.
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    if (i < 2 && !(await box.isChecked())) await box.check();
    if (i >= 2 && (await box.isChecked())) await box.uncheck();
  }
  await expect(picker.getByText(/最多消耗/)).toBeVisible({ timeout: 60_000 });
  await picker.getByRole('button', { name: '开始对比' }).click();

  const card = page.getByRole('region', { name: '多模型对比' });
  await expect(card.getByRole('article')).toHaveCount(2, { timeout: 60_000 });
  const totalText = card.getByText(/本次对比共扣 \d+ 积分/);
  await expect(totalText).toBeVisible({ timeout: 300_000 });
  await meter.checkpoint('journey 5: compare answered');

  const columns = card.getByRole('article');
  const charges: number[] = [];
  for (let i = 0; i < 2; i += 1) {
    const text = await columns.nth(i).getByText(/实际扣费 \d+ 积分/).innerText();
    charges.push(Number(/实际扣费 (\d+) 积分/.exec(text)![1]));
    await expect(columns.nth(i)).not.toContainText('没有回答');
  }
  const shown = Number(/本次对比共扣 (\d+) 积分/.exec(await totalText.innerText())![1]);
  expect(shown).toBe(charges[0]! + charges[1]!);
  // The balance moved by the first chat turn plus the compare; the compare part is the shown total.
  expect(before - (await readCredits(page))).toBeGreaterThanOrEqual(shown);
  await meter.finishJourney('journey 5: compare');
});
