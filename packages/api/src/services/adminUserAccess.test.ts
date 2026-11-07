import { describe, expect, it } from 'vitest';
import { adminUserSearchFilter } from './adminUserAccess';

describe('adminUserSearchFilter (PHONE-OTP admin search)', () => {
  it('keeps the email and nickname search', () => {
    expect(adminUserSearchFilter('alice')).toBe('email.ilike.%alice%,nickname.ilike.%alice%');
  });

  it('adds the phone digits when at least 4 are typed, in any common form', () => {
    expect(adminUserSearchFilter('138 0000 5678')).toContain('phone.like.%13800005678%');
    expect(adminUserSearchFilter('+86 138-0000-5678')).toContain('phone.like.%13800005678%');
    expect(adminUserSearchFilter('008613800005678')).toContain('phone.like.%13800005678%');
    expect(adminUserSearchFilter('5678')).toContain('phone.like.%5678%');
    expect(adminUserSearchFilter('123')).not.toContain('phone');
  });

  it('drops characters PostgREST would read as filter syntax', () => {
    const filter = adminUserSearchFilter('a,b(c)*%');
    expect(filter.split(',')).toHaveLength(2);
    expect(filter).not.toMatch(/[()*]/);
  });
});
