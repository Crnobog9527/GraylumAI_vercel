import { describe, expect, it, vi } from 'vitest';
import { installModelStub, modelStubBase, rewriteToStub } from './loadtest-model-stub';

const env = { LOADTEST_MODEL_STUB_URL: 'https://stub.example.test/sekret', LOADTEST_STUB_DB_HOST: 'db.stg.supabase.co',
  NEXT_PUBLIC_SUPABASE_URL: 'https://db.stg.supabase.co' };

describe('load-test model stub rewrite', () => {
  it('is inert unless both variables are set and the database host is the named staging host', () => {
    expect(modelStubBase({})).toBeNull();
    expect(modelStubBase({ ...env, LOADTEST_STUB_DB_HOST: undefined })).toBeNull();
    expect(modelStubBase({ ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://prod.supabase.co' })).toBeNull();
    expect(modelStubBase({ ...env, LOADTEST_MODEL_STUB_URL: 'http://stub.example.test/x' })).toBeNull();
    expect(modelStubBase({ ...env, LOADTEST_MODEL_STUB_URL: 'https://u:p@stub.example.test/x' })).toBeNull();
    expect(modelStubBase(env)?.href).toBe('https://stub.example.test/sekret');
  });

  it('moves only openrouter.ai requests, keeping path and query', () => {
    const base = modelStubBase(env)!;
    expect(String(rewriteToStub('https://openrouter.ai/api/v1/generation?id=g1', base))).toBe('https://stub.example.test/sekret/api/v1/generation?id=g1');
    expect(String(rewriteToStub(new URL('https://openrouter.ai/api/alpha/decisions'), base))).toBe('https://stub.example.test/sekret/api/alpha/decisions');
    expect(rewriteToStub('https://db.stg.supabase.co/rest/v1/rpc/x', base)).toBeNull();
    expect(rewriteToStub('https://openrouter.ai.evil.test/api', base)).toBeNull();
  });

  it('wraps fetch only when active', async () => {
    const original = vi.fn<typeof fetch>(async () => new Response('ok'));
    const off = { fetch: original };
    expect(installModelStub({}, off)).toBe(false);
    expect(off.fetch).toBe(original);
    const on = { fetch: original };
    expect(installModelStub(env, on)).toBe(true);
    await on.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
    await on.fetch('https://other.example.test/x');
    expect(String(original.mock.calls[0]![0])).toBe('https://stub.example.test/sekret/api/v1/chat/completions');
    expect(String(original.mock.calls[1]![0])).toBe('https://other.example.test/x');
  });

  it('drops the provider key from rerouted requests but leaves other hosts untouched', async () => {
    const original = vi.fn<typeof fetch>(async () => new Response('ok'));
    const scope = { fetch: original };
    installModelStub(env, scope);
    const headers = { authorization: 'Bearer sk-secret', 'content-type': 'application/json' };
    await scope.fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers });
    await scope.fetch(new Request('https://openrouter.ai/api/v1/generation?id=g', { headers }));
    await scope.fetch('https://other.example.test/x', { headers });
    const sent = (i: number) => new Headers(original.mock.calls[i]![1]?.headers);
    expect(sent(0).get('authorization')).toBeNull();
    expect(sent(0).get('content-type')).toBe('application/json');
    expect(sent(1).get('authorization')).toBeNull();
    expect(sent(2).get('authorization')).toBe('Bearer sk-secret');
  });

  it('never reroutes a deployment that lacks either variable or whose database host differs (production shape)', async () => {
    const cases: Record<string, string | undefined>[] = [
      { ...env, LOADTEST_MODEL_STUB_URL: undefined },
      { ...env, LOADTEST_STUB_DB_HOST: undefined },
      { ...env, LOADTEST_MODEL_STUB_URL: '' },
      { ...env, LOADTEST_STUB_DB_HOST: '' },
      { ...env, NEXT_PUBLIC_SUPABASE_URL: undefined },
      { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://prod-ref.supabase.co' },
      { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://db.stg.supabase.co.evil.test' },
      { ...env, NEXT_PUBLIC_SUPABASE_URL: 'not a url' },
      { ...env, VERCEL_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://prod-ref.supabase.co' },
    ];
    for (const e of cases) {
      const original = vi.fn<typeof fetch>(async () => new Response('ok'));
      const scope = { fetch: original };
      expect(installModelStub(e, scope)).toBe(false);
      expect(scope.fetch).toBe(original);
      await scope.fetch('https://openrouter.ai/api/v1/chat/completions');
      expect(String(original.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/chat/completions');
    }
  });
});
