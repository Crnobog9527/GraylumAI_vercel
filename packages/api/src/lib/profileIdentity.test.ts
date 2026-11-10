import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { getAuthProvider, isEmailVerified, verifiedPhoneDigits } from './auth';
import { profileIdentityUpdate, profileInsertPhone } from './profileIdentity';

const phoneUser = (confirmed = true) => ({
  id: 'u', phone: '8613800005678', phone_confirmed_at: confirmed ? '2026-11-08T00:00:00Z' : null, email: '',
  app_metadata: { provider: 'phone', providers: ['phone'] }, identities: [{ provider: 'phone', identity_data: {} }],
}) as unknown as User;
const emailUser = { id: 'u', email: 'a@example.test', email_confirmed_at: '2026-11-08T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, identities: [] } as unknown as User;

describe('PHONE-OTP: a verified phone counts like a verified email', () => {
  it('verifies phone accounts only once Supabase confirmed the number', () => {
    expect(getAuthProvider(phoneUser())).toBe('phone');
    expect(isEmailVerified(phoneUser())).toBe(true);
    expect(isEmailVerified(phoneUser(false))).toBe(false);
    expect(verifiedPhoneDigits(phoneUser())).toBe('8613800005678');
    expect(verifiedPhoneDigits({ ...phoneUser(), phone: '14155550100' } as User)).toBeNull();
  });

  it('copies the phone into the profile for phone accounts and leaves email accounts as before', () => {
    expect(profileIdentityUpdate({ email: null, phone: null }, phoneUser())).toEqual({ phone: '8613800005678' });
    expect(profileIdentityUpdate({ email: null, phone: '8613800005678' }, phoneUser())).toBeNull();
    expect(profileIdentityUpdate({ email: null, phone: null }, phoneUser(false))).toBeNull();
    expect(profileIdentityUpdate({ email: 'old@example.test' }, emailUser)).toEqual({ email: 'a@example.test' });
    expect(profileIdentityUpdate({ email: 'a@example.test' }, emailUser)).toBeNull();
    expect(profileInsertPhone(phoneUser())).toEqual({ phone: '8613800005678' });
    expect(profileInsertPhone(emailUser)).toEqual({});
  });
});
