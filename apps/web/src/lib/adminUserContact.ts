/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { parseStoredPhone } from '@repo/api/src/shared/mainlandPhone';

/**
 * PHONE-OTP: what the admin user list shows under a name. A phone account may have no email, so the verified number
 * (+86 138 0000 5678, full, for support lookups) stands in; an account with neither shows a dash, never an error.
 */
export function adminUserContact(user: { email?: string | null; phone?: string | null }): string {
  if (user.email) return user.email;
  const phone = parseStoredPhone(user.phone);
  if (phone) return `+86 ${phone.national.slice(0, 3)} ${phone.national.slice(3, 7)} ${phone.national.slice(7)}`;
  return '—';
}
