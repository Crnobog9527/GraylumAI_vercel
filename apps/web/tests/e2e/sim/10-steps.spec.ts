import { expect, test } from '@playwright/test';

import { armFault, replies, resetSim, signIn, startFreeChat } from './support';

/**
 * A reply that is only a tool call (the model asks for a Skill's method, or reads the library, and writes nothing until it has it)
 * said "正在回复…" for the whole wait, and people thought the page was stuck. The reply now lists its steps above the text: the step
 * that ended with what it did, "正在思考…" while the next model call runs, then one folded line that opens on a click.
 */
test.beforeEach(resetSim);

test('a load_skill step ends as "已读取…", the reply is thinking until the text, then the steps fold and open on a click', async ({ page }) => {
  await signIn(page, 'alice');
  // The reply's first call is only load_skill for the seeded method; the call after it (with the method in hand) is held back for 6 s.
  await armFault({ mode: 'tool', name: 'load_skill', arguments: { name: 'synthetic-method' } });
  await armFault({ mode: 'slow', delayMs: 6_000 });
  await startFreeChat(page, '帮我按方法写一段分镜。');
  const steps = page.getByRole('status', { name: '这条回复的步骤' });
  await expect(steps.getByText('已读取「synthetic-method」方法')).toBeVisible({ timeout: 60_000 });
  await expect(steps.getByText('正在思考…')).toBeVisible();
  await expect(page.getByText('正在回复…')).toHaveCount(0);
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/测试测试/).first()).toBeVisible();
  // The text flows: the list is one folded line, the detail is out of sight until it is opened.
  const fold = page.getByRole('button', { name: '已完成 1 个步骤' });
  await expect(fold).toBeVisible();
  await expect(page.getByText('已读取「synthetic-method」方法')).toHaveCount(0);
  await fold.click();
  await expect(page.getByText('已读取「synthetic-method」方法')).toBeVisible();
});

test('a read_source step ends in its own words (the local library cannot answer, so it may say so), the same way', async ({ page }) => {
  await signIn(page, 'alice');
  await armFault({ mode: 'tool', name: 'read_source', arguments: { query: '我的资料' } });
  await armFault({ mode: 'slow', delayMs: 6_000 });
  await startFreeChat(page, '看看我资料库里有什么。');
  const steps = page.getByRole('status', { name: '这条回复的步骤' });
  await expect(steps.getByText(/^已查阅资料库|^这次没有查阅资料库|^资料库暂时读取不了/)).toBeVisible({ timeout: 60_000 });
  await expect(steps.getByText('正在思考…')).toBeVisible();
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: /^已完成 1 个步骤/ })).toBeVisible();
});
