import { describe, expect, it, vi } from 'vitest';
import {
  PHONE_CODE_INVALID_MESSAGE, PHONE_SEND_MESSAGES, PHONE_SEND_PATH, phoneSignInAllowed, phoneVerifyErrorMessage, requestPhoneCode,
} from './phoneAuth';

describe('phone sign-in helpers (PHONE-OTP)', () => {
  it('offers phone only on the Simplified entry', () => {
    expect(phoneSignInAllowed(null)).toBe(true);
    expect(phoneSignInAllowed('zh-Hans')).toBe(true);
    expect(phoneSignInAllowed('zh-Hant')).toBe(false);
    expect(phoneSignInAllowed('en')).toBe(false);
  });

  it('posts JSON to the send route and maps every answer to one plain line', async () => {
    const ok = vi.fn(async () => Response.json({ ok: true }));
    expect(await requestPhoneCode({ phone: '+8613800005678', createUser: true }, ok)).toBeNull();
    expect(ok).toHaveBeenCalledWith(PHONE_SEND_PATH, expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }));
    const refused = async () => Response.json({ ok: false, code: 'SMS_DAILY_LIMIT' }, { status: 429 });
    expect(await requestPhoneCode({ phone: 'x', createUser: true }, refused)).toBe(PHONE_SEND_MESSAGES.SMS_DAILY_LIMIT);
    const odd = async () => Response.json({ ok: false, code: '<b>raw</b>' }, { status: 500 });
    expect(await requestPhoneCode({ phone: 'x', createUser: true }, odd)).toBe(PHONE_SEND_MESSAGES.SMS_FAILED);
    expect(await requestPhoneCode({ phone: 'x', createUser: true }, async () => { throw new Error('offline'); })).toBe(PHONE_SEND_MESSAGES.SMS_FAILED);
  });

  it('says a wrong or expired code plainly and nothing else', () => {
    expect(phoneVerifyErrorMessage({ code: 'otp_expired', status: 403 })).toBe(PHONE_CODE_INVALID_MESSAGE);
    expect(phoneVerifyErrorMessage({ code: 'unexpected_failure', status: 500 })).not.toBe(PHONE_CODE_INVALID_MESSAGE);
  });
});
