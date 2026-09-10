/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Same representation accepted by research_user_charge (0071). Ordinary chat
 * permits explicitly configured zero; controlled paid research requires > 0. */
export function parseSearchSurcharge(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^(0|[1-9][0-9]{0,5})$/.test(value)) return null;
  const price = Number(value);
  return Number.isSafeInteger(price) && price >= 0 && price <= 999999 ? price : null;
}
