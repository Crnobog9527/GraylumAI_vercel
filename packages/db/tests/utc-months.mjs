/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Calendar months as the database and Stripe count them: the day is clamped to the target month (Oct 31 + 1 month = Nov 30).
// Date#setUTCMonth overflows instead (Oct 31 + 1 month = Dec 1), which disagrees with the SQL on the 29th-31st.
// scripts/tests/db-test-month-arithmetic.test.mjs keeps every database test on this helper.
export function addUtcMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

// The latest time at or before `at` that can end a one-month term. Nothing ends on Oct 31: Sep 30 + 1 month is Oct 30, and
// there is no Sep 31. A fixture that needs "the term ended just now" has to start from here, or it fails on those days.
export function latestMonthEnd(at) {
  const end = addUtcMonths(addUtcMonths(at, -1), 1);
  if (end.getTime() !== new Date(at).getTime()) end.setUTCHours(23, 59, 59, 0);
  return end;
}
