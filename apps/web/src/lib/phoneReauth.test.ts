import { describe, expect, it, vi } from 'vitest';
import { sendPhoneReauthCode, verifyPhoneReauth } from './phoneReauth';

// PHONE-OTP account-erasure re-verification: allowed only with the session's own number and the right code.
function client(phone: string | null, verifyError: unknown = null) {
  const verifyOtp = vi.fn(async () => ({ error: verifyError }));
  return { verifyOtp, auth: { getUser: async () => ({ data: { user: phone === null ? null : { phone } } }), verifyOtp } };
}

describe('phone re-verification before account erasure', () => {
  it('allows: sends to the session number without creating an account, and accepts the right code', async () => {
    const c = client('8613800005678');
    const send = vi.fn(async () => null);
    expect(await sendPhoneReauthCode(c, 'captcha', send)).toBeNull();
    expect(send).toHaveBeenCalledWith({ phone: '+8613800005678', createUser: false, captchaToken: 'captcha' });
    expect(await verifyPhoneReauth(c, ' 123456 ')).toBeNull();
    expect(c.verifyOtp).toHaveBeenCalledWith({ phone: '+8613800005678', token: '123456', type: 'sms' });
  });

  it('denies: no session number, a refused send, a wrong or malformed code', async () => {
    const send = vi.fn(async () => '验证码刚发过，请 60 秒后再获取。');
    expect(await sendPhoneReauthCode(client(null), 'captcha', send)).toBe('当前会话缺少手机号信息，无法发送验证码。');
    expect(send).not.toHaveBeenCalled();
    expect(await sendPhoneReauthCode(client('8613800005678'), 'captcha', send)).toBe('验证码刚发过，请 60 秒后再获取。');
    const wrong = client('8613800005678', { code: 'otp_expired' });
    expect(await verifyPhoneReauth(wrong, '000000')).toBe('验证码无效或已过期。');
    const untouched = client('8613800005678');
    expect(await verifyPhoneReauth(untouched, '12')).toBe('请输入 6 位验证码。');
    expect(untouched.verifyOtp).not.toHaveBeenCalled();
  });
});
