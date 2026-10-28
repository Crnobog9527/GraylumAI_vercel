import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resultsDirectory, testModelId } from './support/config';
import { coreSql } from './support/db';
import { expect, test } from './support/fixtures';
import { cheapestOther, modelsInLabels, readActiveModels } from './support/models';
import { startFreeChat, waitForRuntimeTurn, runtimeBox } from './support/freeChat';
import { readCredits } from './support/ui';

/**
 * Journey 5: compare two models. The left column is the test model, the right one the cheapest other model on the back-office
 * compare list. Both columns answer; the total charge is exactly the sum of the column charges.
 */
test('journey 5: two models answer and the total equals the sum of the columns @cheap', async ({ openAs, meter }) => {
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
  // A label also carries the quote ("最多 N 积分") once it has loaded, so each is matched to the model name inside it.
  const rawLabels: string[] = [];
  for (let i = 0; i < await boxes.count(); i += 1) rawLabels.push((await boxes.nth(i).locator('xpath=ancestor::label[1]').innerText()).trim());
  const matched = modelsInLabels(await readActiveModels(coreSql()), rawLabels);
  const labels = matched.map((model, i) => model?.name ?? rawLabels[i]!);
  const list = matched.filter((model): model is NonNullable<typeof model> => model !== null);
  const base = list.find(model => model.modelId === testModelId());
  const other = cheapestOther(list);
  expect(base, 'the test model is on the compare list').toBeDefined();
  expect(other, 'a second, cheaper model is on the compare list').not.toBeNull();
  // The other column is recorded for 99-model-check, which allows the test model, the organizer/summary models and this one.
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, 'compare-model.json'), JSON.stringify({ modelId: other!.modelId }));
  // The picker keeps the order in which models are ticked and the columns follow it. Untick everything, then tick the test
  // model first and the other model second, so the test model is the left column.
  for (let i = 0; i < labels.length; i += 1) if (await boxes.nth(i).isChecked()) await boxes.nth(i).uncheck();
  await boxes.nth(labels.indexOf(base!.name)).check();
  await boxes.nth(labels.indexOf(other!.name)).check();
  await expect(picker.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(picker.getByText(/最多消耗/)).toBeVisible({ timeout: 60_000 });
  await picker.getByRole('button', { name: '开始对比' }).click();

  const card = page.getByRole('region', { name: '多模型对比' });
  await expect(card.getByRole('article')).toHaveCount(2, { timeout: 60_000 });
  const totalText = card.getByText(/本次对比共扣 \d+ 积分/);
  await expect(totalText).toBeVisible({ timeout: 300_000 });
  await meter.checkpoint('journey 5: compare answered');

  const columns = card.getByRole('article');
  await expect(columns.nth(0)).toHaveAccessibleName(base!.name);
  await expect(columns.nth(1)).toHaveAccessibleName(other!.name);
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
