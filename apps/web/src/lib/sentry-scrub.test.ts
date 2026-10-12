import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ErrorEvent, Event } from '@sentry/nextjs';
import { APP_SEGMENTS, scrubBreadcrumb, scrubErrorEvent, scrubText, scrubTransactionEvent, scrubUrl } from './sentry-scrub';

const ID = '2d0cb10b-7a62-428d-967f-b049ef5b484d';
const PRIVATE = /李雷|lilei|LiLeiPrivatePlan|a@b\.co|1\.2\.3\.4|203\.0\.113|13800138000|secret|private|sub_1PqR|cus_Q8|gen-synthetic|2d0cb10b/i;

function staticRouteSegments(dir: string, out = new Set<string>()): Set<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (!/^[[(_]/.test(name)) out.add(name);
    staticRouteSegments(path, out);
  }
  return out;
}

describe('sentry allowlist scrub', () => {
  it('keeps only a leading error code from a known domain; names and prose never pass', () => {
    expect(scrubText('为李雷保存并购计划失败')).toBe('[text]');
    expect(scrubText('ACME merger failed')).toBe('[text]');
    expect(scrubText('LI_LEI profile failed')).toBe('[text]');
    expect(scrubText('ACCOUNT_ERASURE_FAILED: 李雷的账号')).toBe('ACCOUNT_ERASURE_FAILED');
  });

  it('knows every static route segment of the app', () => {
    const missing = [...staticRouteSegments(resolve(__dirname, '../app'))].filter((name) => !APP_SEGMENTS.has(name));
    expect(missing).toEqual([]);
  });

  it('turns our URLs into route templates and third-party URLs into hosts', () => {
    expect(scrubUrl(`https://auth-staging.graylum.com/positioning/${ID}?email=a@b.co#x`))
      .toBe('https://auth-staging.graylum.com/positioning/:param');
    expect(scrubUrl('GET /positioning/LiLeiPrivatePlan')).toBe('GET /positioning/:param');
    expect(scrubUrl('/api/trpc/payments.createCheckout,admin.searchUsers?input=%7B%22q%22%3A%22lilei%22%7D'))
      .toBe('/api/trpc/payments.createCheckout,admin.searchUsers');
    expect(scrubUrl('GET https://api.stripe.com/v1/subscriptions/sub_1PqR2sT3uVwXyZ')).toBe('GET https://api.stripe.com');
    expect(scrubUrl('https://auth-staging.graylum.com/_next/static/chunks/main-abc123.js?v=1'))
      .toBe('https://auth-staging.graylum.com/_next/static/chunks/main-abc123.js');
    expect(scrubUrl('李雷的计划')).toBe('[text]');
  });

  it('rebuilds error events from the allowlist only', () => {
    const event = {
      event_id: 'e1', timestamp: 1, platform: 'javascript', level: 'error', environment: 'staging', release: 'r1',
      user: { id: ID, email: 'a@b.co', ip_address: '1.2.3.4' }, server_name: 'host',
      request: { method: 'POST', url: `https://x.graylum.com/api/x/${ID}?token=t`, data: '{"prompt":"secret plan"}',
        headers: { cookie: 'sb=1' }, query_string: 'token=t' },
      message: 'failed for a@b.co', logentry: { message: 'saved plan for %s', params: ['李雷'] },
      extra: { phone: 13800138000, prompt: 'private idea' }, fingerprint: ['李雷'],
      tags: { draft: ID, runtime: 'node', customer: 'lilei' },
      contexts: { trace: { trace_id: 't', span_id: 's', data: { 'http.client_ip': '203.0.113.9' } },
        os: { name: 'macOS', version: '15', kernel_version: 'x' }, profile: { email: 'a@b.co' } },
      exception: { values: [{ type: 'Error', value: `Profile ${ID} rejected a@b.co`,
        mechanism: { type: 'generic', handled: true, data: { x: 1 } },
        stacktrace: { frames: [{ filename: 'app:///_next/static/chunks/a.js?v=1', function: 'save', lineno: 3, vars: { input: 'secret' } }] } }] },
      breadcrumbs: [{ category: 'console', message: 'user typed: secret' },
        { category: 'fetch', level: 'info', data: { method: 'GET', url: '/positioning/LiLeiPrivatePlan?q=1', status_code: 200, body: 'x' } }],
    } as unknown as ErrorEvent;
    const out = scrubErrorEvent(event);
    expect(JSON.stringify(out)).not.toMatch(PRIVATE);
    expect(out).toEqual({
      event_id: 'e1', timestamp: 1, platform: 'javascript', level: 'error', environment: 'staging', release: 'r1',
      request: { method: 'POST', url: 'https://x.graylum.com/api/:param/:param' },
      message: '[text]', logentry: { message: '[text]' }, tags: { runtime: 'node' },
      contexts: { trace: { trace_id: 't', span_id: 's' }, os: { name: 'macOS', version: '15' } },
      breadcrumbs: [{ category: 'fetch', level: 'info', data: { method: 'GET', status_code: 200, url: '/positioning/:param' } }],
      exception: { values: [{ type: 'Error', value: '[text]', mechanism: { type: 'generic', handled: true },
        stacktrace: { frames: [{ function: 'save', lineno: 3, filename: 'app:///_next/static/chunks/a.js', abs_path: undefined }] } }] },
    });
  });

  it('keeps span timing, status, model names and counts; drops ids, messages and addresses', () => {
    const event = {
      type: 'transaction', transaction: `GET /positioning/${ID}`, start_timestamp: 1, timestamp: 2, measurements: { lcp: { value: 1 } },
      spans: [
        { span_id: 'a', op: 'http.client', description: 'GET https://api.stripe.com/v1/customers/cus_Q8a7Bc9De0', status: 'ok',
          data: { 'http.method': 'GET', 'http.url': 'https://api.stripe.com/v1/customers/cus_Q8a7Bc9De0', 'http.client_ip': '203.0.113.9' } },
        { span_id: 'b', op: 'gen_ai.chat', description: 'chat 李雷', data: { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 12,
          'gen_ai.response.id': 'gen-synthetic', 'gen_ai.request.messages': '[{"content":"secret"}]' } },
        { span_id: 'c', op: 'db', description: "select * from profiles where email='a@b.co'", data: { 'db.system': 'postgresql' } },
      ],
    } as unknown as Event;
    const out = scrubTransactionEvent(event);
    expect(JSON.stringify(out)).not.toMatch(PRIVATE);
    expect(out.transaction).toBe('GET /positioning/:param');
    expect(out.measurements).toEqual({ lcp: { value: 1 } });
    expect(out.spans).toEqual([
      { span_id: 'a', op: 'http.client', status: 'ok', description: 'GET https://api.stripe.com', data: { 'http.method': 'GET' } },
      { span_id: 'b', op: 'gen_ai.chat', description: 'gen_ai.chat', data: { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 12 } },
      { span_id: 'c', op: 'db', description: 'db', data: { 'db.system': 'postgresql' } },
    ]);
  });

  it('drops console breadcrumbs entirely', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'anything' })).toBeNull();
  });
});
