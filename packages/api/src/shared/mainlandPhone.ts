/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PHONE-OTP (MASTER_PLAN §2.1, Owner 2026-11-07): mainland China mobile numbers only, +86 then 11
 * digits starting 1[3-9]. Pure, so the login page's field check uses the same rule as the server.
 * Supabase keeps a phone as E.164 digits without the '+' (8613800005678).
 */

/** How long a code works: the SMS OTP expiry set in Supabase (300 s), shown on the code step and sent as `min`. */
export const SMS_CODE_MINUTES = 5;
export const SMS_CODE_LENGTH = 6;
/** The wait between two codes for one number, enforced by sms_request_send. */
export const SMS_RESEND_SECONDS = 60;

export type MainlandPhone = {
  /** '+8613800005678': what signInWithOtp and verifyOtp take. */
  e164: string;
  /** '8613800005678': how auth.users.phone and the Send SMS hook payload carry it. */
  digits: string;
  /** '13800005678': what a mainland SMS provider is given. */
  national: string;
};

const NATIONAL = /^1[3-9]\d{9}$/;

/** The national number with spaces or dashes, or the same with a +86, 0086 or 86 prefix. */
export function parseMainlandPhone(input: string | null | undefined): MainlandPhone | null {
  if (typeof input !== 'string') return null;
  let digits = input.trim().replace(/[\s-]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+86')) return null;
    digits = digits.slice(3);
  } else if (digits.startsWith('0086')) {
    digits = digits.slice(4);
  } else if (digits.length === 13 && digits.startsWith('86')) {
    digits = digits.slice(2);
  }
  if (!NATIONAL.test(digits)) return null;
  return { e164: `+86${digits}`, digits: `86${digits}`, national: digits };
}

/** The stored form (auth.users.phone, the hook payload): digits with the 86, an optional leading '+'. */
export function parseStoredPhone(stored: string | null | undefined): MainlandPhone | null {
  if (typeof stored !== 'string') return null;
  const digits = stored.replace(/^\+/, '');
  return /^86\d{11}$/.test(digits) ? parseMainlandPhone(`+${digits}`) : null;
}

/** 138****5678 for the account page and wherever a number is shown back; '' when not a mainland number. */
export function maskPhone(stored: string | null | undefined): string {
  const phone = parseStoredPhone(stored);
  return phone ? `${phone.national.slice(0, 3)}****${phone.national.slice(7)}` : '';
}
