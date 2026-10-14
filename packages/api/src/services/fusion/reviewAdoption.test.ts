/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adoptionSections, applyChoices } from './reviewAdoption';

describe('per-section adoption', () => {
  it('keeps unchosen sections byte for byte, including unusual heading spacing and CRLF', () => {
    const original = '前言\r\n##\t定位\r\n原定位\r\n##   结语\r\n原结语';
    const revised = '前言\r\n## 定位\r\n新定位\r\n## 结语\r\n新结语';
    const plan = adoptionSections({ originalBody: original, revisedBody: revised, sections: ['定位', '结语'], changedSections: ['定位', '结语'],
      changeNotes: [{ section: '定位', wordingOnly: true, fields: [] }, { section: '结语', wordingOnly: true, fields: [] }], frozen: {}, revisedSteps: {} });
    const merged = applyChoices({ originalBody: original, revisedBody: revised, plan,
      choices: [{ section: '定位', use: 'revised', confirmedNoFactChange: true }, { section: '结语', use: 'original' }] });
    expect(merged.body).toBe('前言\r\n## 定位\r\n新定位\r\n##   结语\r\n原结语');
    expect(merged).toMatchObject({ adopted: ['定位'], kept: ['结语'] });
  });
});
