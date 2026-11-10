import { beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => [] as unknown[]);
vi.mock('../../lib/logger', () => {
  const record = (...args: unknown[]) => { logs.push(args); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

import { parseMainlandPhone } from '../../shared/mainlandPhone';
import { phoneKey } from './phoneKey';
import type { SmsLimitStatus } from './smsLimits';
import { handleSmsHook, type SmsHookDeps } from './smsHook';
import { fakeSmsSender } from './sms/fake';
import type { SmsMessage, SmsSender } from './sms/types';
import { signWebhookPayload } from './webhookSignature';

const RAW = Buffer.from('0123456789abcdef0123456789abcdef');
const SECRET = `v1,whsec_${RAW.toString('base64')}`;
const NOW = 1_762_500_000_000;
const CODE = '731942';

function request(payload: unknown, sign = true) {
  const body = JSON.stringify(payload);
  const timestamp = String(NOW / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'webhook-id': 'msg_1', 'webhook-timestamp': timestamp };
  if (sign) headers['webhook-signature'] = `v1,${signWebhookPayload(RAW, 'msg_1', timestamp, body)}`;
  return new Request('https://example.test/api/auth/sms-hook', { method: 'POST', headers, body });
}
const payload = (phone: string | null = '8613800005678', otp = CODE) => ({ user: { id: 'user-1', phone }, sms: { otp } });

describe('handleSmsHook (Supabase Send SMS hook)', () => {
  let outbox: SmsMessage[];
  let deps: SmsHookDeps;
  let authorize: ReturnType<typeof vi.fn<(key: string) => Promise<SmsLimitStatus>>>;
  beforeEach(() => {
    logs.length = 0;
    outbox = [];
    authorize = vi.fn(async (): Promise<SmsLimitStatus> => 'ok');
    deps = { secret: SECRET, sender: { sender: fakeSmsSender(outbox) }, authorize, now: () => NOW };
  });

  it('checks the signature and the limits, then sends the code with the 5 minutes, keyed by the number hash', async () => {
    const response = await handleSmsHook(request(payload()), deps);
    expect(response.status).toBe(200);
    expect(outbox).toEqual([{ to: { e164: '+8613800005678', national: '13800005678' }, code: CODE, validMinutes: 5 }]);
    const key = phoneKey(parseMainlandPhone('13800005678')!, SECRET);
    expect(authorize).toHaveBeenCalledWith(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('13800005678');
  });

  it('refuses before calling the provider: bad signature, other countries, a limit, no configuration', async () => {
    const send = vi.fn();
    const watched: SmsSender = { name: 'aliyun', send };
    deps.sender = { sender: watched };
    expect((await handleSmsHook(request(payload(), false), deps)).status).toBe(401);
    expect((await handleSmsHook(request(payload('14155550100')), deps)).status).toBe(400);
    expect((await handleSmsHook(request(payload('8613800005678', '12')), deps)).status).toBe(400);
    for (const status of ['phone_cooldown', 'phone_daily', 'ip_daily', 'no_request'] as const) {
      authorize.mockResolvedValueOnce(status);
      const response = await handleSmsHook(request(payload()), deps);
      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { http_code: 429 } });
    }
    expect((await handleSmsHook(request(payload()), { ...deps, secret: undefined })).status).toBe(503);
    expect((await handleSmsHook(request(payload()), { ...deps, sender: { problem: 'SMS_PROVIDER is not set' } })).status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps provider refusals and database failures, and never logs or returns the code', async () => {
    deps.sender = { sender: { name: 'aliyun', send: async () => ({ ok: false, reason: 'rejected', providerCode: 'BUSINESS_LIMIT_CONTROL' }) } };
    const rejected = await handleSmsHook(request(payload()), deps);
    expect(rejected.status).toBe(429);
    deps.sender = { sender: { name: 'aliyun', send: async () => ({ ok: false, reason: 'failed', providerCode: 'network' }) } };
    expect((await handleSmsHook(request(payload()), deps)).status).toBe(502);
    authorize.mockRejectedValueOnce(new Error(`db down ${CODE}`));
    const failed = await handleSmsHook(request(payload()), deps);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain(CODE);
    expect(JSON.stringify(logs)).not.toContain('13800005678');
    expect(JSON.stringify(logs)).toContain('138****5678');
  });
});
