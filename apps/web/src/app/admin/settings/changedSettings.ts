/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type Displayed = Record<string, { value: string }>;

const shownValue = (saved: Record<string, unknown> | null | undefined, defaults: Displayed, key: string) =>
  saved && Object.hasOwn(saved, key) ? String(saved[key]) : defaults[key]?.value;

/**
 * "保存所有设置" writes only keys the admin actually changed. A value is compared with what the page
 * first showed (the stored row, or the page default when no row exists), so an untouched default is
 * never turned into stored configuration — e.g. it must not create billing_credits_per_usd by accident.
 */
export function changedSettings(current: Displayed, saved: Record<string, unknown> | null | undefined, defaults: Displayed) {
  return Object.entries(current)
    .filter(([key, data]) => {
      return data.value !== shownValue(saved, defaults, key);
    })
    .map(([key, data]) => ({ key, value: data.value }));
}

/**
 * Applies newly read settings to the page. A field the admin edited but has not saved yet (its value
 * differs from what the previous read showed) keeps the edit, so re-reading after saving one section
 * (for example the Fusion limit) never silently drops unsaved edits in other tabs.
 */
export function mergeReadSettings<T extends { value: string }>(
  defaults: Record<string, T>,
  saved: Record<string, unknown> | null | undefined,
  current: Record<string, T>,
  previousSaved: Record<string, unknown> | null | undefined,
): Record<string, T> {
  return Object.fromEntries(Object.entries(defaults).map(([key, base]) => {
    const edited = current[key] !== undefined && current[key].value !== shownValue(previousSaved, defaults, key);
    return [key, { ...base, value: edited ? current[key].value : shownValue(saved, defaults, key) ?? base.value }];
  }));
}
