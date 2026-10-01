/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { changedSettings } from './changedSettings';

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
