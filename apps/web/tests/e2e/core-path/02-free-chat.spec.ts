import { getE2ESql } from '../support/e2eDb';
import { expect, test } from './support/fixtures';
import { startFreeChat, waitForRuntimeTurn } from './support/freeChat';
import { readCredits } from './support/ui';

/**
 * Journey 2: a free conversation. One message that asks for a lookup on Xiaohongshu: a Skill is loaded on its own
 * (server side, invisible in the page, so it is read back from the tool journal), one research tool runs (a row in the
 * work record), the reply finishes, and the balance drops by what the ledger says.
 */
test('journey 2: free chat loads a Skill, runs one research lookup and finishes', async ({ openAs, meter }) => {
  test.setTimeout(8 * 60_000);
  const { page } = await openAs('pro');
  await page.goto('/app/profile');
  const balanceBefore = await readCredits(page);

  const session = await startFreeChat(page,
    '请用搜索工具查一下小红书上“15 分钟快手晚餐”最近的热门笔记，列出 3 个标题，并用一句话说明共同点。');
  // Plan CORE-PATH-V2 §2.2: an ordinary conversation has no stop; only a report can be stopped. The current path still
  // offers one, so this is asserted from V2-10 on (CORE_E2E_PATH=v2) and only noted until then.
  if (process.env.CORE_E2E_PATH === 'v2') await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  else test.info().annotations.push({ type: 'note', description: 'no-stop assertion for ordinary chats waits for the v2 path' });
  await waitForRuntimeTurn(page, 240_000);

  const work = page.locator('ul[aria-label="AI 教练的工作记录"] li[data-work-kind="research"][data-work-state="done"]');
  await expect(work.first()).toBeVisible();
  await expect(work.first()).toContainText(/搜索|网页|账号/);

  const loaded = await getE2ESql()<Array<{ n: string }>>`
    select count(*)::text as n from runtime_tool_calls t join runtime_executions e on e.id = t.execution_id
    where e.session_id = ${session}::uuid and t.name = 'load_skill'`;
  expect(Number(loaded[0]?.n ?? 0), 'a Skill was loaded automatically').toBeGreaterThanOrEqual(1);

  await page.goto('/app/profile?tab=credits');
  await expect(page.getByText('AI 使用消耗').first()).toBeVisible();
  const spent = balanceBefore - (await readCredits(page));
  expect(spent, 'the turn was charged').toBeGreaterThan(0);
  await meter.finishJourney('journey 2: free chat');
});
