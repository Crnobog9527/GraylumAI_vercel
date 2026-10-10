/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { addUtcCalendarMonthsClamped } from '../subscriptionCreditGrants';

const DAY = 86400000;
function instant(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || !/T.*Z$/.test(value)) throw new Error('PAY_WAFFO_TERM_INVALID');
  return time;
}

/** All inputs must come from locked orders / verified provider facts. Pure calculation only;
 * qualification and grant writes belong to the atomic fulfillment transaction. */
export function walletMembershipTerm(input: {
  paidAt: string; term: 'month' | 'year' | 'days30';
  founderRenewal?: { originalEnd: string; eligibleUntil: string };
}) {
  const paid = instant(input.paidAt);
  let start = paid;
  if (input.founderRenewal) {
    if (input.term !== 'year' || paid > instant(input.founderRenewal.eligibleUntil)) {
      throw new Error('PAY_WAFFO_FOUNDER_EXPIRED');
    }
    start = instant(input.founderRenewal.originalEnd);
  }
  const end = input.term === 'days30' ? start + 30 * DAY
    : addUtcCalendarMonthsClamped(new Date(start), input.term === 'year' ? 12 : 1).getTime();
  if (end <= paid) throw new Error('PAY_WAFFO_TERM_INVALID');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function membershipGrantWindows(input: {
  orderId: string; start: string; end: string; yearly: boolean; credits: number;
}) {
  const start = instant(input.start), end = instant(input.end);
  const count = input.yearly ? 12 : 1;
  if (end <= start || !Number.isSafeInteger(input.credits) || input.credits <= 0
    || (input.yearly && addUtcCalendarMonthsClamped(new Date(start), 12).getTime() !== end)) {
    throw new Error('PAY_WAFFO_TERM_INVALID');
  }
  return Array.from({ length: count }, (_, index) => ({
    key: `payment:${input.orderId}:${String(index + 1).padStart(2, '0')}`,
    index: input.yearly ? index + 1 : null, total: count,
    start: input.yearly ? addUtcCalendarMonthsClamped(new Date(start), index).toISOString() : input.start,
    end: input.yearly ? new Date(Math.min(end,
      addUtcCalendarMonthsClamped(new Date(start), index + 1).getTime())).toISOString() : input.end,
    credits: Math.floor(input.credits / count) + (index < input.credits % count ? 1 : 0),
  }));
}

/** Pause only the qualification clock, never paid entitlement. Merge overlapping outages to
 * prevent duplicated notifications from granting extra grace. Open outages keep it paused. */
export function founderGraceDeadline(input: {
  failedRenewalAt: string; now: string;
  outages: Array<{ start: string; end: string | null }>;
}) {
  const start = instant(input.failedRenewalAt), now = instant(input.now);
  if (now < start) throw new Error('PAY_WAFFO_TERM_INVALID');
  const intervals = input.outages.map(outage => {
    const from = instant(outage.start), to = outage.end ? instant(outage.end) : now;
    if (to < from) throw new Error('PAY_WAFFO_TERM_INVALID');
    return [Math.max(start, from), Math.min(now, to)] as const;
  }).filter(([from, to]) => to > from).sort((a, b) => a[0] - b[0]);
  let deadline = start + 7 * DAY;
  let previousEnd = start;
  for (const [from, to] of intervals) {
    // An outage after qualification was already lost cannot revive it.
    if (from > deadline) break;
    deadline += Math.max(0, to - Math.max(from, previousEnd));
    previousEnd = Math.max(previousEnd, to);
  }
  return new Date(deadline).toISOString();
}

export function assertProUpgradeWindow(input: {
  now: string; nextChargeAt: string | null; retrying: boolean; stateKnown: boolean; checkoutExpiresAt: string;
}) {
  const now = instant(input.now), expiry = instant(input.checkoutExpiresAt);
  if (!input.stateKnown || input.retrying || !input.nextChargeAt) throw new Error('PAY_WAFFO_UPGRADE_WAIT');
  const charge = instant(input.nextChargeAt);
  if (charge - now <= 48 * 3600000 || expiry <= now || expiry >= charge - 48 * 3600000
    || expiry - now > 30 * 60000) throw new Error('PAY_WAFFO_UPGRADE_WAIT');
}
