/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 2026-11-11 (UI-UNIFY): these four profile-center files still carried the old dark theme's shapes after the page went
// light: gradient buttons and gradient numbers, purple and blue tints, cards that lift on hover, 16px cards. They now use
// the signed-in baseline (DESIGN.md "Card", "Button": white 12px card with a border and no shadow, a solid dark action,
// gold only as a tag). This keeps the old shapes from coming back by copy and paste.
const FILES = ['PersonalInfoCard.tsx', 'CreditPackagesSection.tsx', 'CreditRecordsCard.tsx', 'SecuritySettingsCard.tsx'];
const OLD: Array<[string, RegExp]> = [
  ['a gradient', /linear-gradient|WebkitBackgroundClip/],
  ['a purple or blue tint written as a literal colour', /rgba\((139, 92, 246|59, 130, 246)/],
  ['a card that lifts or glows on hover', /hover:-translate|hover:shadow-\[|0 0 20px/],
  ['a 16px card', /rounded-2xl/],
];

describe('profile center cards follow the signed-in baseline', () => {
  it.each(FILES)('%s has none of the old dark theme shapes', file => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const [what, pattern] of OLD) expect(pattern.test(source), `${file}: ${what}`).toBe(false);
  });
});
