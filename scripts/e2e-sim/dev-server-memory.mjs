/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The simulated-model browser tests (layer 1) run the app on `next dev`. Next's dev server restarts itself after a request once its V8 heap
// is above 80% of the heap limit ("Server is approaching the used memory threshold, restarting..."), and every restart drops the compiled
// pages: the next page load compiles again, and a journey waiting on a page (for example a login form's scripts) can run out of time while
// that happens. The limit is Node's default (a quarter of the machine's memory, at most about 4 GB), which the later, heavier journeys
// reach after twenty minutes of compiling routes. The server is given a larger heap, and every run now reports how often it restarted,
// so the number is measured instead of guessed (before this, a run that passed did not say).

/** Heap limit of the dev server in MB. The CI runner has 16 GB; the database, the browser and the simulators need about 3 GB of it. */
export const DEV_SERVER_HEAP_MB = 6144;

/** NODE_OPTIONS of the dev server: the sim preload first (its path has no spaces, run.mjs checks), then the heap limit. */
export function devServerNodeOptions(preloadPath, heapMb = DEV_SERVER_HEAP_MB) {
  return `--require=${preloadPath} --max-old-space-size=${heapMb}`;
}

/** Reads the dev server's output (any chunking) and counts its starts, its memory restarts and the largest heap limit a process reported. */
export function createMemoryWatch() {
  let pending = '';
  const seen = { starts: 0, restarts: 0, heapLimitMb: null };
  const read = line => {
    if (line.includes('approaching the used memory threshold')) seen.restarts += 1;
    // Next says "Ready in …" once per start of the server (the first and after every restart). Every process the server forks also loads the
    // preload and says its heap limit, so only the number is kept, never a count of those lines.
    if (/Ready in \d/.test(line)) seen.starts += 1;
    const limit = /\[sim-preload\] heap_size_limit_mb=(\d+)/.exec(line);
    if (limit) seen.heapLimitMb = Math.max(seen.heapLimitMb ?? 0, Number(limit[1]));
  };
  return {
    feed(text) {
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(read);
    },
    summary() {
      if (pending) { read(pending); pending = ''; }
      return { ...seen };
    },
  };
}
