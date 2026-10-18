import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('played stages and scenarios are remembered only while the page is open (Owner 2026-10-18)', () => {
  it('keeps them in memory: never stored, the old stored lists cleared and never read', () => {
    for (const name of ['LaterStepsL.tsx', 'ScenariosL.tsx']) {
      const source = read(name);
      expect(source, name).not.toContain('sessionStorage');
      expect(source, name).not.toMatch(/localStorage\.(getItem|setItem)\(OLD_PLAYED_KEY/);
      expect(source, name).toMatch(/localStorage\.removeItem\(OLD_PLAYED_KEY\)/);
    }
    expect(read('LaterStepsL.tsx')).toContain("'graylum-landing-l-later-played'");
    expect(read('ScenariosL.tsx')).toContain("'graylum-landing-l-scenarios-played'");
    expect(read('LaterStepsL.tsx')).not.toMatch(/localStorage\.(getItem|setItem)/);
  });

  it('still remembers in this browser who has seen step one and region 6, so they may skip them', () => {
    expect(read('StepsL.tsx')).toMatch(/localStorage\.getItem\(SEEN_KEY\)/);
    expect(read('StepsL.tsx')).toContain("'graylum-landing-l-step-one-seen'");
    expect(read('ScenariosL.tsx')).toMatch(/localStorage\.getItem\(SEEN_KEY\)/);
    expect(read('ScenariosL.tsx')).toContain("'graylum-landing-l-scenarios-seen'");
  });
});
