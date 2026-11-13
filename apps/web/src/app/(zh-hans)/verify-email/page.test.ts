/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The page draws its form only after it has looked the session up in the browser, so what it says is read from its source here.
const source = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
/** What the page writes on the screen: the text between its tags, and the attributes a visitor can see or hover. */
const shown = [...source.matchAll(/>([^<>{}]*)</g)].map(match => match[1]!.trim()).filter(Boolean);

describe('/verify-email, what it says about where it goes next', () => {
  // Owner 2026-11-13: "验证成功以后，它会直接把这个目录都写出来，删掉目录 /app/profile 的展示。直接就说验证成功后将进入应用。"
  it('says 验证成功后将进入应用 and shows no path', () => {
    expect(shown).toContain('验证成功后将进入应用。');
    expect(shown.filter(text => text.includes('将进入'))).toEqual(['验证成功后将进入应用。']);
    // No address is written out: not as text, not as a tooltip, not cut short with an ellipsis.
    for (const text of shown) expect(text, text).not.toMatch(/\/app|\/[a-z-]+\/[a-z-]+/);
    expect(source).not.toMatch(/\{\s*(?:displayRedirect\()?redirectTarget\)?\s*\}/);
    expect(source).not.toMatch(/title=\{redirectTarget\}/);
    expect(source).not.toContain('displayRedirect');
  });

  it('still goes to the page that was asked for', () => {
    // The target is read from the address and cleaned, used for the move after verifying and for the link in the email, as before.
    expect(source).toContain("sanitizeRedirectTarget(searchParams.get('redirect'))");
    expect(source).toContain('router.replace(redirectTarget)');
    expect(source).toContain('buildAuthCallbackUrl(resolveAuthAppUrl(window.location.origin), redirectTarget)');
    expect(source).toContain("useState('/app/profile')");
  });
});
