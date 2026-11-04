import { expect, test } from '@playwright/test';

import { armFault, replies, resetSim, signIn, startFreeChat } from './support';

/**
 * A reply that is only a tool call (the model asks for a Skill's method and writes nothing until it has it) said "正在回复…" for the
 * whole wait, and people thought the page was stuck. The page now says what the wait is, and the words go away when the text starts.
 */
test.beforeEach(resetSim);

test('a load_skill call shows which method is being read, then the text replaces the line', async ({ page }) => {
  await signIn(page, 'alice');
  // The reply's first call is only load_skill for the seeded method; the call after it (with the method in hand) is held back for 5 s.
  await armFault({ mode: 'tool', name: 'load_skill', arguments: { name: 'synthetic-method' } });
  await armFault({ mode: 'slow', delayMs: 5_000 });
  await startFreeChat(page, '帮我按方法写一段分镜。');
  await expect(page.getByText('正在读取「synthetic-method」方法…')).toBeVisible({ timeout: 60_000 });
  // The server named the method, not an id; the generic line is not shown at the same time.
  await expect(page.getByText('正在回复…')).toHaveCount(0);
  await expect(replies(page).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/测试测试/).first()).toBeVisible();
  await expect(page.getByText(/正在读取「/)).toHaveCount(0);
});
