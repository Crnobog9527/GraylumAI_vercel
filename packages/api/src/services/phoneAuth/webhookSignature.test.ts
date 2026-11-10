import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature, webhookSecretBytes } from './webhookSignature';

// Throwaway secret, in the form Supabase shows (v1,whsec_<base64>).
const RAW = Buffer.from('0123456789abcdef0123456789abcdef');
const SECRET = `v1,whsec_${RAW.toString('base64')}`;
const NOW = 1_762_500_000_000;
const BODY = '{"user":{"id":"u","phone":"8613800005678"},"sms":{"otp":"123456"}}';

function headers(values: Record<string, string>) {
  return new Headers(values);
}
function signed(body = BODY, timestamp = String(NOW / 1000), id = 'msg_1') {
  return headers({ 'webhook-id': id, 'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signWebhookPayload(RAW, id, timestamp, body)}` });
}

describe('verifyWebhookSignature (Standard Webhooks)', () => {
  it('accepts a genuine request, also among several signatures and with the bare whsec_ secret', () => {
    expect(verifyWebhookSignature(SECRET, signed(), BODY, NOW)).toBeNull();
    const many = signed();
    many.set('webhook-signature', `v1,bm9wZQ== ${many.get('webhook-signature')}`);
    expect(verifyWebhookSignature(SECRET, many, BODY, NOW)).toBeNull();
    expect(verifyWebhookSignature(`whsec_${RAW.toString('base64')}`, signed(), BODY, NOW)).toBeNull();
  });

  it('refuses a changed body, a wrong secret, a stale or missing timestamp and missing headers', () => {
    expect(verifyWebhookSignature(SECRET, signed(), BODY.replace('123456', '654321'), NOW)).toBe('mismatch');
    const other = `v1,whsec_${Buffer.from('fedcba9876543210fedcba9876543210').toString('base64')}`;
    expect(verifyWebhookSignature(other, signed(), BODY, NOW)).toBe('mismatch');
    expect(verifyWebhookSignature(SECRET, signed(BODY, String(NOW / 1000 - 301)), BODY, NOW)).toBe('stale');
    expect(verifyWebhookSignature(SECRET, signed(BODY, 'soon'), BODY, NOW)).toBe('stale');
    expect(verifyWebhookSignature(SECRET, headers({ 'webhook-id': 'x' }), BODY, NOW)).toBe('missing_headers');
    expect(verifyWebhookSignature('v1,whsec_c2hvcnQ=', signed(), BODY, NOW)).toBe('bad_secret');
    const v2 = signed();
    v2.set('webhook-signature', (v2.get('webhook-signature') ?? '').replace(/^v1,/, 'v2,'));
    expect(verifyWebhookSignature(SECRET, v2, BODY, NOW)).toBe('mismatch');
  });

  it('reads only well-formed secrets', () => {
    expect(webhookSecretBytes(SECRET)?.equals(RAW)).toBe(true);
    expect(webhookSecretBytes('v1,whsec_not base64!')).toBeNull();
  });
});
