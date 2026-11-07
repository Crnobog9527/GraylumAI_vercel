/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import type { ConsentSnapshot } from '@/lib/analytics/consent';
import { useConsentWithdrawalSync } from './use-consent-withdrawal-sync';
import { useSignupReporting } from './use-signup-reporting';

/**
 * The two statistics steps that talk to our server (tRPC), kept apart from the consent bar and the statistics scripts,
 * which need no server at all: a refusal or withdrawal is told to the server for a logged-in account (ANALYTICS §7 PR-3),
 * and right after sign-up, with live consent, `sign_up` and the first source go to the account (§3.1, §3.2).
 */
export function AccountConsentSync({ consent, reportable }: { consent: ConsentSnapshot; reportable: boolean }) {
  useConsentWithdrawalSync(consent, true);
  useSignupReporting(consent.analytics && reportable);
  return null;
}
