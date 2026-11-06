/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The simulated-model browser tests (layer 1) run the app on `next dev`. Next's dev server restarts itself after a request once its V8 heap
// is above 80% of its heap limit ("Server is approaching the used memory threshold, restarting..."), and every restart drops the compiled
// pages: the next page load compiles again, and a journey waiting on a page (for example a login form's scripts) can run out of time while
// that happens. Next's own launcher gives the server half of the machine's memory as its heap limit when none is set (8 GB on the 16 GB CI
// runner), so the limit is not left at Node's default: setting one here would only lower it. What was missing is the measurement: a run that
// passed said nothing, and a failed run showed only the last lines of the server's log. Every run now reports how often the server
// restarted, the heap limit it really had and the highest heap it used.

/** NODE_OPTIONS of the dev server: the sim preload only (its path has no spaces, run.mjs checks). No heap option: see above. */
export function devServerNodeOptions(preloadPath) {
  return `--require=${preloadPath}`;
}

/** Reads the dev server's output (any chunking) and counts its starts, its memory restarts, its heap limit and its peak used heap. */
export function createMemoryWatch() {
  // Each stream (stdout, stderr) has its own half-written line.
  const pending = new Map();
  const seen = { starts: 0, restarts: 0, heapLimitMb: null, peakHeapUsedMb: null };
  const read = line => {
    if (line.includes('approaching the used memory threshold')) seen.restarts += 1;
    // Next says "Ready in …" once per start of the server (the first and after every restart).
    if (/Ready in \d/.test(line)) seen.starts += 1;
    const limit = /\[sim-preload\] heap_size_limit_mb=(\d+)/.exec(line);
    if (limit) seen.heapLimitMb = Math.max(seen.heapLimitMb ?? 0, Number(limit[1]));
    const used = /\[sim-preload\] heap_used_mb=(\d+)/.exec(line);
    if (used) seen.peakHeapUsedMb = Math.max(seen.peakHeapUsedMb ?? 0, Number(used[1]));
  };
  return {
    feed(text, stream = 'out') {
      const lines = ((pending.get(stream) ?? '') + text).split('\n');
      pending.set(stream, lines.pop() ?? '');
      lines.forEach(read);
    },
    summary() {
      for (const [stream, rest] of pending) { if (rest) read(rest); pending.set(stream, ''); }
      return { ...seen };
    },
  };
}

/** The server's own log without the preload's measurement lines (they come every 30 seconds and would push real lines out of the tail). */
export const withoutMeasurements = text => text.replace(/^\[sim-preload\] .*\n?/gm, '');
