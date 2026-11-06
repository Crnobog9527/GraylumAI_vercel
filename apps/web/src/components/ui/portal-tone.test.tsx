import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lightDialogStyle, lightMenuStyle, lightOverlayClass, lightPanelStyle } from '@/components/design/light-portal';

/*
 * UI-UNIFY A0: Radix content is portalled to <body> (static markup renders no portal, and the app has no DOM test environment), so the
 * values and the wiring are checked here and the look is checked in the browser (screenshots in the PR).
 */
describe('portal tone', () => {
  it('the light panel uses the light tokens: white panel, dialog radius and shadow, a lighter backdrop', () => {
    expect(lightPanelStyle.background).toBe('var(--gl-surface)');
    expect(lightDialogStyle.borderRadius).toBe('var(--gl-radius-dialog)');
    expect(lightDialogStyle.boxShadow).toBe('var(--gl-shadow-dialog)');
    expect(lightMenuStyle.boxShadow).toBe('var(--gl-shadow-menu)');
    expect(lightOverlayClass).toBe('bg-black/40');
  });
  it('Dialog, AlertDialog, Sheet and Select take the tone and apply it only when it is "light"', () => {
    for (const file of ['dialog', 'alert-dialog', 'sheet', 'select']) {
      const text = readFileSync(join(import.meta.dirname, `${file}.tsx`), 'utf8');
      expect(text, file).toMatch(/tone\?: PortalTone/);
      expect(text, file).toMatch(/tone === ["']light["'] && lightPortalClass/);
      expect(text, file).toMatch(/tone === ["']light["'] \? \{ \.\.\.light(Dialog|Panel|Menu)Style, \.\.\.style \} : style/);
    }
  });
  it('the dialogs this change moved to the light tone ask for it', () => {
    const source = join(import.meta.dirname, '..', '..');
    expect(readFileSync(join(source, 'components/fusion-compare/ComparePicker.tsx'), 'utf8')).toContain('<DialogContent tone="light"');
    expect(readFileSync(join(source, 'app/(zh-hans)/app/positioning/[draftId]/report-panel.tsx'), 'utf8')).toContain('<AlertDialogContent tone="light"');
    // UI-UNIFY A (phone check): the profile center's phone menu is a light sheet, not the dark 80% backdrop.
    expect(readFileSync(join(source, 'app/(zh-hans)/app/profile/page.tsx'), 'utf8')).toMatch(/<SheetContent\s+tone="light"/);
  });
});
