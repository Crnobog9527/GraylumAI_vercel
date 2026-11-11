import { randomUUID } from 'node:crypto';

import { expect, test } from './fixtures';

import { armFault, replies, resetSim, runRecovery, signIn, simCalls, startFreeChat } from './support';

/**
 * Compiles every route the journeys use, before any of them runs, on an account no journey looks at.
 *
 * The local app is a development server: the first visit to a page or API route compiles it, and a compile stalls the server's own
 * event loop. The web proxy refuses a request (503) when its rate-limit backend has not answered within a fixed 1 s, so a stalled
 * loop turns into a refused request, and a page whose one-shot query was refused simply never shows its button. That is what made
 * the first journey fail now and then (2026-11-03). Warming the routes up first removes the cause; it hides nothing: a refusal that
 * still happens in a journey is still a failure.
 */
test.beforeEach(resetSim);

test('warm-up: compile the routes the journeys use', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  await signIn(page, 'warm');
  // The start page, one free-chat turn (session start, the conversation page, the turn route, its view and results), the library
  // and its voice tab, the profile, and the recovery job. Failures here are not asserted: only that every route has been compiled.
  await startFreeChat(page, '预热：说一句话。');
  await expect(replies(page).first()).toBeVisible({ timeout: 4 * 60_000 }).catch(() => undefined);
  // A turn that fails: the first journey that does (02-failures, the 402 refusal) was the one that failed now and then (2026-11-05, twice in
  // 47 runs, both as `turn_limit_unavailable` beside a 503 on the conversation list), and nothing before it had run a failing turn, so what
  // that path loads on first use was compiled in the middle of that journey. The provider refuses, the turn closes, the page says so.
  await armFault({ mode: '402' });
  await startFreeChat(page, '预热：模拟失败。');
  // Wait for the refusal itself (the simulator has seen the 402 call), not for a text to go away: before the first request is sent the page
  // shows a skeleton and that text is not there yet. Then let the page settle on the closed turn.
  await expect.poll(async () => (await simCalls()).filter(call => call.fault === '402').length, { timeout: 120_000, intervals: [500, 1000] })
    .toBe(1).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  // Also the pages that the first CI run with stall measurements (#1794) saw compile in the middle of later journeys: the signed-in home,
  // the positioning draft pages (any id compiles them), the marketplace, the publish monitor and the scan check; and, signed out, the
  // forgot-password page. (/api/turn compiled a second time in one journey: a recompile cannot be warmed.) The search page of the workbench
  // was the one route every run still compiled in the middle of a journey (08-no-loading-words; four CI runs of 2026-11-11).
  const draft = randomUUID();
  for (const path of ['/app/library', '/app/library?tab=voice', '/app/profile', '/app/profile?tab=credits', '/app/positioning', '/app',
    `/app/positioning/${draft}`, `/app/positioning/${draft}/topics`, `/app/positioning/${draft}/review/${randomUUID()}`,
    '/app/workbench/marketplace', '/app/workbench/search', '/app/publish-monitor', '/app/library/scan-check']) {
    await page.goto(path, { waitUntil: 'networkidle', timeout: 3 * 60_000 }).catch(() => undefined);
  }
  await page.context().clearCookies();
  await page.goto('/forgot-password', { waitUntil: 'networkidle', timeout: 3 * 60_000 }).catch(() => undefined);
  await runRecovery().catch(() => undefined);
});
