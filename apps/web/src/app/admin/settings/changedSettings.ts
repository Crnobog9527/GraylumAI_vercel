/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
type Displayed = Record<string, { value: string }>;

/**
 * "保存所有设置" writes only keys the admin actually changed. A value is compared with what the page
 * first showed (the stored row, or the page default when no row exists), so an untouched default is
 * never turned into stored configuration — e.g. it must not create billing_credits_per_usd by accident.
 */
export function changedSettings(current: Displayed, saved: Record<string, unknown> | null | undefined, defaults: Displayed) {
  return Object.entries(current)
    .filter(([key, data]) => {
      const shown = saved && Object.hasOwn(saved, key) ? String(saved[key]) : defaults[key]?.value;
      return data.value !== shown;
    })
    .map(([key, data]) => ({ key, value: data.value }));
}
