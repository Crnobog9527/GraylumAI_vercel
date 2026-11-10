import { describe, expect, it } from 'vitest';
import { maskPhone, parseMainlandPhone, parseStoredPhone } from './mainlandPhone';

describe('parseMainlandPhone (PHONE-OTP: +86 only)', () => {
  it('accepts a mainland mobile number with or without the country prefix', () => {
    const expected = { e164: '+8613800005678', digits: '8613800005678', national: '13800005678' };
    for (const input of ['13800005678', ' 138 0000 5678 ', '138-0000-5678', '+8613800005678', '008613800005678', '8613800005678']) {
      expect(parseMainlandPhone(input)).toEqual(expected);
    }
  });

  it('refuses other countries, landlines, short numbers and non-strings', () => {
    for (const input of ['+1 415 555 0100', '+85291234567', '12800005678', '1380000567', '138000056789', '02012345678', '',
      'abc', null, undefined]) {
      expect(parseMainlandPhone(input as string)).toBeNull();
    }
  });
});

describe('parseStoredPhone and maskPhone', () => {
  it('reads the stored digits (with or without +) and masks the middle four', () => {
    expect(parseStoredPhone('8613800005678')?.e164).toBe('+8613800005678');
    expect(parseStoredPhone('+8613800005678')?.national).toBe('13800005678');
    expect(maskPhone('8613800005678')).toBe('138****5678');
    expect(maskPhone('+8613800005678')).toBe('138****5678');
  });

  it('gives nothing back for anything else', () => {
    expect(parseStoredPhone('14155550100')).toBeNull();
    expect(parseStoredPhone('13800005678')).toBeNull();
    expect(maskPhone(null)).toBe('');
    expect(maskPhone('14155550100')).toBe('');
  });
});
