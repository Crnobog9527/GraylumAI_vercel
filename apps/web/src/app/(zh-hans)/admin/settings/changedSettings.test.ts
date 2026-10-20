/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { changedSettings, mergeReadSettings } from './changedSettings';

const defaults = { site_name: { value: 'Graylum' }, billing_credits_per_usd: { value: '' }, max_input_characters: { value: '2000' } };

describe('changedSettings', () => {
  it('writes nothing when nothing changed, even for keys that have no stored row', () => {
    expect(changedSettings(defaults, { site_name: 'Graylum' }, defaults)).toEqual([]);
    expect(changedSettings(defaults, undefined, defaults)).toEqual([]);
  });

  it('writes only the edited key; untouched billing keys never become stored rows', () => {
    const current = { ...defaults, max_input_characters: { value: '3000' } };
    expect(changedSettings(current, { max_input_characters: 2000 }, defaults)).toEqual([{ key: 'max_input_characters', value: '3000' }]);
  });

  it('compares with the stored value, not the page default', () => {
    const saved = { billing_credits_per_usd: 1000 };
    const shown = { ...defaults, billing_credits_per_usd: { value: '1000' } };
    expect(changedSettings(shown, saved, defaults)).toEqual([]);
    expect(changedSettings({ ...shown, billing_credits_per_usd: { value: '100' } }, saved, defaults))
      .toEqual([{ key: 'billing_credits_per_usd', value: '100' }]);
  });
});

describe('mergeReadSettings', () => {
  const base = { site_name: { value: 'Graylum', label: '平台名称' }, max_input_characters: { value: '', label: '上限' } };

  it('shows the stored values on first load', () => {
    expect(mergeReadSettings(base, { site_name: 'A', max_input_characters: 3000 }, {}, undefined)).toEqual({
      site_name: { value: 'A', label: '平台名称' }, max_input_characters: { value: '3000', label: '上限' },
    });
  });

  it('keeps an unsaved edit and takes the new stored value for untouched fields', () => {
    const before = { site_name: 'A', max_input_characters: 3000 };
    const current = { site_name: { value: '我的修改', label: '平台名称' }, max_input_characters: { value: '3000', label: '上限' } };
    const after = { site_name: 'A', max_input_characters: 4000, fusion_compare_max_models: 6 };
    expect(mergeReadSettings(base, after, current, before)).toEqual({
      site_name: { value: '我的修改', label: '平台名称' }, max_input_characters: { value: '4000', label: '上限' },
    });
  });

  it('treats an edit of a field with no stored row as unsaved', () => {
    const current = { site_name: { value: 'Graylum', label: '平台名称' }, max_input_characters: { value: '2500', label: '上限' } };
    expect(mergeReadSettings(base, {}, current, {}).max_input_characters.value).toBe('2500');
  });

  it('after saving all, the stored values equal the edits', () => {
    const current = { site_name: { value: 'B', label: '平台名称' }, max_input_characters: { value: '', label: '上限' } };
    expect(mergeReadSettings(base, { site_name: 'B' }, current, { site_name: 'A' }).site_name.value).toBe('B');
  });
});
