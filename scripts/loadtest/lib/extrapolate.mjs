/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Plan 3.3.3: what a single-machine run must prove is not "this machine holds 5000 users" but two statements: the database work of a turn
// (k, core-seconds per turn) does not change between 500 and 5000 users, and lock waits do not grow with users. Everything below is arithmetic
// on measured numbers; capacity is given as an order of magnitude with its uncertainties, never as an exact head count.
export const K_TOLERANCE = 0.15; // plan 3.1: k across 500 -> 5000 stays within +-15%
export const WAIT_SHARE_LIMIT = 2; // percent of sampled backends waiting on a lock manager / tuple lock
export const CPU_TARGET = 0.6; // plan 3.3.1: leave headroom for spikes

// Rhythms (plan 3.3.1): the load-test rhythm is 0.93 turns per user per minute; the human rhythm is a guess (0.3), not measured.
export const RHYTHM = { load: 0.93, human: 0.3 };

// Supabase sizes of plan 3.3.1 (cores are what k is divided into; shared cores are not dedicated, see UNCERTAINTIES).
export const SIZES = [
  { name: 'Micro (now)', cores: 2, shared: true }, { name: 'Small / Medium', cores: 2, shared: true }, { name: 'Large', cores: 2, shared: false },
  { name: 'XL', cores: 4, shared: false }, { name: '2XL', cores: 8, shared: false }, { name: '4XL', cores: 16, shared: false },
];

export const UNCERTAINTIES = [
  'Shared-core burst credit (Micro / Small / Medium): the measured k is on a fixed-core container, the hosted size throttles when credit runs out.',
  'Memory and swap: a larger table lowers the cache hit rate; the run reports shared_buffers and the table sizes it ran with.',
  'Disk IOPS: the local disk is not the hosted disk; WAL per turn is measured, the hosted IOPS limit is not.',
  'Network round trip: 0 ms here; 1-5 ms x the turn\'s round trips on Vercel -> database (adds latency, not database CPU).',
  'PostgREST, Supavisor and JSON encoding are outside the database container here; the 3x factor of plan 3.3.1 stands in for them '
    + 'until the 100-user run gives k on the hosted stack.',
  'Provider rate limits (OpenRouter and the search vendors) are not exercised by the stub.',
  'Human rhythm (0.3 turns per user per minute) has no measurement; replace it with production data after launch.',
];

const mean = values => values.reduce((a, b) => a + b, 0) / values.length;

// k = database core-seconds per completed turn.
export const coreSecondsPerTurn = ({ cpuSeconds, turns }) => (turns > 0 ? cpuSeconds / turns : null);

// levels: [{ users, k }] -> spread of k relative to the mean, and whether it is within tolerance. Needs at least two levels.
export function kStable(levels, tolerance = K_TOLERANCE) {
  const ks = levels.map(l => l.k).filter(Number.isFinite);
  if (ks.length < 2) return { stable: null, spread: null, mean: ks[0] ?? null };
  const m = mean(ks);
  const spread = Math.max(...ks.map(k => Math.abs(k - m) / m));
  return { stable: spread <= tolerance, spread: Number(spread.toFixed(3)), mean: m };
}

// Lock-wait share per level must stay under the limit AND not climb with users (last level not above the first by more than the limit).
export function waitsFlat(levels, limit = WAIT_SHARE_LIMIT) {
  const shares = levels.map(l => l.waitPercent).filter(Number.isFinite);
  if (shares.length < 2) return { flat: null, max: shares[0] ?? null };
  const max = Math.max(...shares);
  return { flat: max < limit && shares[shares.length - 1] - shares[0] <= limit, max: Number(max.toFixed(2)) };
}

// Turns per minute a size completes at CPU_TARGET, then the users that is at a rhythm: cores x 60 s x target / k.
export function capacityTable(k, sizes = SIZES, rhythm = RHYTHM) {
  return sizes.map(size => {
    const perMinute = (size.cores * 60 * CPU_TARGET) / k;
    return { size: size.name, turnsPerMinute: Math.round(perMinute), loadRhythmUsers: Math.round(perMinute / rhythm.load),
      humanRhythmUsers: Math.round(perMinute / rhythm.human) };
  });
}

// An order of magnitude on a half-decade scale (1, 3, 10, 30, 100, ...): the report quotes this, never a precise head count.
export const magnitude = n => (n > 0 ? Number((10 ** (Math.round(Math.log10(n) * 2) / 2)).toPrecision(1)) : 0);
