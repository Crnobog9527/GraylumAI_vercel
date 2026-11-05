import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { resetSim, signIn } from './support';

/**
 * A light page must already be light in the server HTML (the marker <LightFirstPaint/>, which globals.css turns into a light body), or a
 * refresh paints one black frame first (#1738). The pages with an id in the path (a positioning draft and its sub-pages) are the ones a
 * path read during the server render can miss, so the HTML of each kind is read here, not only the path table.
 */
test.beforeEach(resetSim);

const MARKER = 'data-first-paint="light"';
const HEAD_SCRIPT = "setAttribute('data-first-paint','light')";
const html = async (page: import('@playwright/test').Page, path: string) => {
  const response = await page.request.get(path, { headers: { accept: 'text/html' }, timeout: 180_000 });
  expect(response.status(), path).toBeLessThan(400);
  return response.text();
};

test('the server HTML of every light signed-in page carries the light marker, a dark one does not', async ({ page }) => {
  // The local app is a dev server: the first request of each page compiles it (tens of seconds).
  test.setTimeout(900_000);
  await signIn(page, 'alice');
  const id = randomUUID();
  for (const path of ['/app', '/app/runtime', '/app/positioning', `/app/positioning/${id}`, `/app/positioning/${id}/topics`,
    `/app/positioning/${id}/review/${randomUUID()}`, '/app/library', '/app/profile'])
    {
      const text = await html(page, path);
      expect(text, path).toContain(MARKER);
      // The first chunk of the document ends inside <body> for some pages, so the decision must also be in the head (a script that runs before the first paint).
      expect(text.indexOf(HEAD_SCRIPT), path).toBeGreaterThan(-1);
      expect(text.indexOf(HEAD_SCRIPT), path).toBeLessThan(text.indexOf('<body'));
    }
  expect(await html(page, '/app/library/scan-check'), '/app/library/scan-check').not.toContain(MARKER);
});

test('a client navigation from a light page to a dark one takes the light mark off, and back', async ({ page }) => {
  test.setTimeout(900_000);
  await signIn(page, 'alice');
  const state = () => page.evaluate(() => ({ mark: document.documentElement.getAttribute('data-first-paint'),
    background: getComputedStyle(document.body).backgroundColor, path: location.pathname }));
  await page.goto('/app/runtime', { timeout: 180_000 });
  await expect.poll(state, { timeout: 60_000 }).toMatchObject({ mark: 'light', background: 'rgb(247, 247, 247)' });
  // Next's own router, as a link click does: the root layout stays mounted.
  await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push('/app/library/scan-check'));
  await expect.poll(state, { timeout: 180_000 }).toMatchObject({ path: '/app/library/scan-check', mark: null });
  expect((await state()).background).not.toBe('rgb(247, 247, 247)');
  await page.evaluate(() => (window as unknown as { next: { router: { push(href: string): void } } }).next.router.push('/app/runtime'));
  await expect.poll(state, { timeout: 180_000 }).toMatchObject({ path: '/app/runtime', mark: 'light', background: 'rgb(247, 247, 247)' });
});
