import { describe, expect, it } from 'vitest';
import { adminUserContact } from './adminUserContact';

describe('adminUserContact (PHONE-OTP admin list)', () => {
  it('shows the email, else the phone, else a dash', () => {
    expect(adminUserContact({ email: 'a@example.test', phone: '8613800005678' })).toBe('a@example.test');
    expect(adminUserContact({ email: null, phone: '8613800005678' })).toBe('+86 138 0000 5678');
    expect(adminUserContact({ email: '', phone: null })).toBe('—');
    expect(adminUserContact({})).toBe('—');
  });
});
