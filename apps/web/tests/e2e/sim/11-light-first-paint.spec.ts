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
    `/app/positioning/${id}/review/${randomUUID()}`, '/app/library'])
    {
      const text = await html(page, path);
      expect(text, path).toContain(MARKER);
      // The first chunk of the document ends inside <body> for some pages, so the decision must also be in the head (a script that runs before the first paint).
      expect(text.indexOf(HEAD_SCRIPT), path).toBeGreaterThan(-1);
      expect(text.indexOf(HEAD_SCRIPT), path).toBeLessThan(text.indexOf('<body'));
    }
  expect(await html(page, '/app/profile'), '/app/profile').not.toContain(MARKER);
});
