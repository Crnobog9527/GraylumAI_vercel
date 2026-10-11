/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from './errors';

/**
 * Loading a parser Worker bundle (built by scripts/build-library-sandbox.mjs, same origin, never a
 * CDN) and the whole-run deadline, shared by the Word (LIB-2b) and PDF (LIB-2c) clients.
 */

const sources = new Map<string, Promise<string>>();

export function loadWorkerBundle(bundlePath: string): Promise<string> {
  let source = sources.get(bundlePath);
  if (source) return source;
  // The site proxy guards this path like any page (signed-in users only), so the session cookie is
  // sent; a redirect (e.g. to /login) or a non-script response is refused rather than run.
  source = fetch(bundlePath, { credentials: 'same-origin', cache: 'no-cache', redirect: 'error' })
    .then((response) => {
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !/javascript/i.test(type)) throw new SandboxError('SANDBOX_UNAVAILABLE');
      return response.text();
    })
    .catch((error: unknown) => {
      sources.delete(bundlePath);
      throw error instanceof SandboxError ? error : new SandboxError('SANDBOX_UNAVAILABLE');
    });
  sources.set(bundlePath, source);
  return source;
}

/** Settles with `task`, or rejects with SANDBOX_TIMEOUT at the deadline or on cancellation. */
export function withinDeadline<T>(task: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new SandboxError('SANDBOX_TIMEOUT'));
    if (signal?.aborted) return stop();
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    signal?.addEventListener('abort', stop, { once: true });
    task.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    });
  });
}
