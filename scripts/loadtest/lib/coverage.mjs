/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Did a sampler's samples cover the driver's run? Each sampler line is JSON with `t` (ms). The run window is { startMs, endMs } of the
// driver. Covered = the first sample is not later than the start (plus one interval) and the last is not earlier than the end (minus one).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function coverage(times, window, slackMs) {
  if (!times.length) return { ok: false, samples: 0, reason: 'no samples' };
  const first = Math.min(...times), last = Math.max(...times);
  const startGapMs = first - window.startMs, endGapMs = window.endMs - last;
  return { ok: startGapMs <= slackMs && endGapMs <= slackMs, samples: times.length, startGapMs, endGapMs, slackMs };
}

export const timesOf = text => text.split('\n').filter(Boolean).map(l => JSON.parse(l).t).filter(Number.isFinite);

// node coverage.mjs <window.json> <slackSeconds> <sampler file>...   exits 1 when any file does not cover the window
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [windowFile, slackSeconds, ...files] = process.argv.slice(2);
  const window = JSON.parse(readFileSync(windowFile, 'utf8'));
  let bad = false;
  for (const file of files) {
    const result = coverage(timesOf(readFileSync(file, 'utf8')), window, Number(slackSeconds) * 1000);
    console.log(`${result.ok ? 'COVERED' : 'NOT COVERED'} ${file} ${JSON.stringify(result)}`);
    bad ||= !result.ok;
  }
  process.exit(bad ? 1 : 0);
}
