import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The hook itself needs React and the tRPC client; the ordering rule is checked on its source: the "sent" marker is
// written only after the awaited request AND a recheck of liveness and of the live consent state.
describe('consent withdrawal sync ordering', () => {
  const source = readFileSync(new URL('./use-consent-withdrawal-sync.ts', import.meta.url), 'utf8');
  it('rechecks liveness and live consent between the request and the marker', () => {
    const mutate = source.indexOf('withdrawConsent.mutate()');
    const recheck = source.indexOf('if (!active || analyticsAllowed()) return;');
    const marker = source.indexOf('sessionStorage.setItem(SENT_KEY');
    expect(mutate).toBeGreaterThan(-1);
    expect(recheck).toBeGreaterThan(mutate);
    expect(marker).toBeGreaterThan(recheck);
  });
});
