import { describe, expect, it } from 'vitest';
import type { ErrorEvent, Event } from '@sentry/nextjs';
import { scrubBreadcrumb, scrubErrorEvent, scrubText, scrubTransactionEvent, scrubUrl } from './sentry-scrub';

const ID = '2d0cb10b-7a62-428d-967f-b049ef5b484d';

describe('sentry scrub', () => {
  it('redacts emails, ids, tokens, keys and long numbers, and truncates long text', () => {
    const text = scrubText(`user a.b+c@example.com ${ID} Bearer abc.def.ghi sk-or-v1-0123456789abcdef phone +86 138 0013 8000`);
    expect(text).not.toMatch(/example\.com|2d0cb10b|abc\.def|0123456789abcdef|138/);
    expect(text).toContain('[email]');
    expect(text).toContain('[id]');
    expect(scrubText('x'.repeat(1000)).length).toBeLessThanOrEqual(301);
  });

  it('drops query strings and fragments from urls and redacts ids in the path', () => {
    expect(scrubUrl(`https://auth-staging.graylum.com/positioning/${ID}?email=a@b.co&code=123#frag`))
      .toBe('https://auth-staging.graylum.com/positioning/[id]');
  });

  it('removes user, request bodies, headers, cookies and local variables from error events', () => {
    const event = {
      user: { id: ID, email: 'a@b.co', ip_address: '1.2.3.4' },
      server_name: 'host',
      request: { method: 'POST', url: `https://x.test/api?token=t`, data: '{"prompt":"secret plan"}',
        headers: { cookie: 'sb=1', authorization: 'Bearer z' }, cookies: { sb: '1' }, query_string: 'token=t' },
      message: 'failed for a@b.co',
      extra: { prompt: 'my private idea', count: 3, nested: { content: 'body text', url: 'https://x.test/p?q=1' } },
      tags: { draft: ID },
      exception: { values: [{ value: `Profile ${ID} rejected a@b.co`, stacktrace: { frames: [{ vars: { input: 'x' } }] } }] },
      breadcrumbs: [{ category: 'console', message: 'user typed: secret' }, { category: 'fetch', data: { url: 'https://x.test/a?b=1', body: 'x' } }],
    } as unknown as ErrorEvent;
    const out = scrubErrorEvent(event);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/a@b\.co|1\.2\.3\.4|secret plan|my private idea|body text|token=t|sb=1|2d0cb10b|user typed/);
    expect(out.user).toBeUndefined();
    expect(out.request).toEqual({ method: 'POST', url: 'https://x.test/api' });
    expect(out.extra).toMatchObject({ prompt: '[removed]', count: 3, nested: { content: '[removed]', url: 'https://x.test/p' } });
    expect(out.breadcrumbs).toEqual([{ category: 'fetch', data: { url: 'https://x.test/a', body: '[removed]' } }]);
    expect(out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toBeUndefined();
  });

  it('scrubs transaction names and span urls', () => {
    const event = {
      transaction: `GET /positioning/${ID}`,
      spans: [{ description: `GET https://openrouter.ai/api?key=1`, data: { 'http.url': 'https://x.test/a?b=1', 'http.query': 'b=1' } }],
    } as unknown as Event;
    const out = scrubTransactionEvent(event);
    expect(out.transaction).toBe('GET /positioning/[id]');
    expect(out.spans?.[0]).toMatchObject({ description: 'GET https://openrouter.ai/api',
      data: { 'http.url': 'https://x.test/a', 'http.query': '[removed]' } });
  });

  it('drops console breadcrumbs entirely', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'anything' })).toBeNull();
  });
});
