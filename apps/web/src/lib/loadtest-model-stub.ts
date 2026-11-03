/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Final 100-user validation (CORE-PATH-V2 plan 3.2): on the STAGING deployment only, the three OpenRouter requests the turn path makes
// (chat completions, generation receipt, positioning decisions) go to the load-test model stub instead, so a real Vercel run spends
// nothing on models. The origin `https://openrouter.ai` is fixed in the code, so this rewrites the outgoing fetch.
//
// Inert unless BOTH variables are set, and active only when the database this deployment talks to is the one named in
// LOADTEST_STUB_DB_HOST (the staging Supabase host); setting them on any other deployment changes nothing.
//   LOADTEST_MODEL_STUB_URL   https base URL of the stub, secret path prefix included, no credentials
//   LOADTEST_STUB_DB_HOST     the staging database host (the host of NEXT_PUBLIC_SUPABASE_URL)
const OPENROUTER_ORIGIN = 'https://openrouter.ai';

type Env = Record<string, string | undefined>;

export function modelStubBase(env: Env): URL | null {
  const raw = env.LOADTEST_MODEL_STUB_URL?.trim();
  const dbHost = env.LOADTEST_STUB_DB_HOST?.trim();
  if (!raw || !dbHost || !env.NEXT_PUBLIC_SUPABASE_URL) return null;
  try {
    const base = new URL(raw);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) return null;
    if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).host !== dbHost) return null;
    return base;
  } catch { return null; }
}

export function rewriteToStub(input: RequestInfo | URL, base: URL): RequestInfo | URL | null {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
  if (url.origin !== OPENROUTER_ORIGIN) return null;
  const target = new URL(`${base.pathname.replace(/\/$/, '')}${url.pathname}${url.search}`, base.origin);
  return input instanceof Request ? new Request(target, input) : target;
}

export function installModelStub(env: Env = process.env, scope: { fetch: typeof fetch } = globalThis): boolean {
  const base = modelStubBase(env);
  if (!base) return false;
  const original = scope.fetch.bind(scope);
  scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = rewriteToStub(input, base);
    if (!target) return original(input, init);
    // The stub needs no credential and sits behind a third-party tunnel: the provider key must never leave with the request.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete('authorization');
    return original(target, { ...init, headers });
  }) as typeof fetch;
  return true;
}
