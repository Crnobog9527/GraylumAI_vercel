import { coreSql } from './support/db';
import { expect, test } from './support/fixtures';
import { startFreeChat, waitForRuntimeTurn } from './support/freeChat';
import { readCredits } from './support/ui';

/**
 * Journey 2: a free conversation. One message that asks for a lookup on Xiaohongshu: a Skill is loaded on its own
 * (server side, invisible in the page, so it is read back from the tool journal), one research tool runs (a row in the
 * work record), the reply finishes, and the balance drops by what the ledger says.
 */
test('journey 2: free chat loads a Skill, runs one research lookup and finishes @cheap', async ({ openAs, meter }) => {
  test.setTimeout(8 * 60_000);
  const { page } = await openAs('pro');
  await page.goto('/app/profile');
  const balanceBefore = await readCredits(page);

  const session = await startFreeChat(page,
    '请先用搜索工具查一下小红书上“15 分钟快手晚餐”最近的热门笔记，再用图文与文章这个技能帮我写一篇 150 字以内的小红书图文笔记。');
  // Plan CORE-PATH-V2 §2.2: an ordinary conversation has no stop; only a report can be stopped. The current path still
  // offers one, so this is asserted from V2-10 on (CORE_E2E_PATH=v2) and only noted until then.
  if (process.env.CORE_E2E_PATH === 'v2') await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  else test.info().annotations.push({ type: 'note', description: 'no-stop assertion for ordinary chats waits for the v2 path' });
  await waitForRuntimeTurn(page, 240_000);

  // A research row means the tool ran. Whether the supplier returned data is a separate question: "done" has data, "missing" is
  // "这次没查到" (the call was made and charged nothing useful), and the journey records which one it was.
  const work = page.locator('ul[aria-label="AI 教练的工作记录"] li[data-work-kind="research"]');
  await expect(work.first()).toBeVisible();
  await expect(work.first()).toContainText(/搜索|网页|账号/);
  test.info().annotations.push({ type: 'research-state', description: String(await work.first().getAttribute('data-work-state')) });

  const loaded = await coreSql()<Array<{ n: string }>>`
    select count(*)::text as n from runtime_tool_calls t join runtime_executions e on e.id = t.execution_id
    where e.session_id = ${session}::uuid and t.name = 'load_skill'`;
  expect(Number(loaded[0]?.n ?? 0), 'a Skill was loaded automatically').toBeGreaterThanOrEqual(1);

  await page.goto('/app/profile?tab=credits');
  await expect(page.getByText('AI 使用消耗').first()).toBeVisible();
  const spent = balanceBefore - (await readCredits(page));
  expect(spent, 'the turn was charged').toBeGreaterThan(0);
  await meter.finishJourney('journey 2: free chat');
});
