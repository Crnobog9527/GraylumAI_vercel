/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adoptionSections, applyChoices, sectionTexts } from './reviewAdoption';

describe('per-section adoption', () => {
  it('gives the reader the whole report: the text before the first section and every section as written', () => {
    expect(sectionTexts('# 定位报告\r\n写在前面。\r\n##\t定位\r\n原定位\r\n## 结语\r\n原结语', ['定位', '结语'])).toEqual({
      preamble: '# 定位报告\r\n写在前面。', chapters: [{ section: '定位', body: '原定位' }, { section: '结语', body: '原结语' }] });
    expect(sectionTexts('## 定位\n原定位', ['定位', '结语']).preamble).toBe('');
  });
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

  it('refuses a mix of revised and original sections that exceeds the length limit, before anything is proposed', () => {
    const original = '## 定位\n' + '甲'.repeat(50) + '\n## 结语\n' + '乙'.repeat(10);
    const revised = '## 定位\n' + '甲'.repeat(10) + '\n## 结语\n' + '丙'.repeat(50);
    const plan = adoptionSections({ originalBody: original, revisedBody: revised, sections: ['定位', '结语'], changedSections: ['定位', '结语'],
      changeNotes: [{ section: '定位', wordingOnly: true, fields: [] }, { section: '结语', wordingOnly: true, fields: [] }], frozen: {}, revisedSteps: {} });
    expect(() => applyChoices({ originalBody: original, revisedBody: revised, plan, maxCharacters: 90,
      choices: [{ section: '定位', use: 'original' }, { section: '结语', use: 'revised', confirmedNoFactChange: true }] })).toThrow('FUSION_ADOPTION_TOO_LONG');
  });
});
