/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const phone = (name: string) => [...read(name).replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@media\(max-width:639px\)\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  .map(match => match[1]).join('\n');
const DIALOGS = [
  ['content-editor', 'modal', '编辑标题与正文'], ['version-compare', 'dialog', '历史版本'], ['strategy-overview-dialog', 'dialog', '定位详情'],
] as const;

// Owner 2026-11-12, phone plan A: on a phone a dialog rises from the foot of the screen instead of sitting in the middle as a
// small window. The three dialogs the library, the rail and the conversation pages share use the same sheet as the others (#1936).
describe('the editor, the version history and the positioning details on a phone', () => {
  it.each(DIALOGS)('%s: its overlay lays it at the foot of the screen and it is the shared sheet', (name, panel, label) => {
    const source = read(`${name}.tsx`);
    expect(source).toContain("import sheet from '@/components/design/bottom-sheet.module.css';");
    expect(source).toContain('className={`${styles.backdrop} ${sheet.host}`}');
    expect(source).toMatch(new RegExp(`aria-label="${label}"[^>]*className=\\{\`\\$\\{styles\\.${panel}\\} \\$\\{sheet\\.panel\\}`));
  });

  it('the shared sheet changes nothing above 639px, so a computer keeps the three dialogs as they were', () => {
    const sheet = readFileSync(join(__dirname, '../design/bottom-sheet.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const outside = sheet.replace(/@media \(max-width: 639px\)[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').replace(/@keyframes[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').trim();
    expect(outside).toBe('');
    expect(sheet).toMatch(/\.host \{ align-items: flex-end !important; padding: 0 !important; \}/);
  });

  it.each(DIALOGS)('%s: on a phone its close button and its main buttons are a thumb\'s height', (name, panel) => {
    const css = phone(`${name}.module.css`);
    // The sheet's grabber is placed against the dialog, and the head leaves it room.
    expect(css).toMatch(new RegExp(`\\.${panel}\\{position:relative`));
    expect(css).toMatch(/button\{display:grid;place-items:center;(?:flex:none;)?width:44px;height:44px/);
    expect(css).toMatch(/button(?:,[^{]*)?\{[^}]*min-height:48px/);
    expect(css).not.toMatch(/animation|transition/);
  });

  it('the history opens inside the editor, so its finish button outranks the editor\'s rule for a footer\'s buttons', () => {
    // `.editor footer button` (content-editor.module.css) is one class and two tags; a bare `.footer button` loses to it.
    expect(read('content-editor.module.css')).toContain('.editor footer button{width:100%;min-height:40px');
    expect(phone('version-compare.module.css')).toContain('.dialog .footer button{flex:none;width:auto;min-height:48px');
  });

  it('boxes one types into are at 16px on a phone, so the phone does not zoom the page in', () => {
    expect(phone('content-editor.module.css')).toContain('.modalFields input,.modalFields textarea{font-size:16px}');
    expect(phone('strategy-overview-dialog.module.css')).toContain('.dialog textarea,.dialog input{font-size:16px}');
  });
});
