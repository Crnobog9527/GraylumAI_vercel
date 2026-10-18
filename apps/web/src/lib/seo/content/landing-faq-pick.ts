/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { faqAnswerText, LANDING_FAQ } from '@/lib/landing/landing-faq';
import { allOn, resolveLandingFlags } from '@/lib/landing/landing-flags';

// Public content pages reuse the landing page's own FAQ answers and its sign-up grant wording, so they follow the same
// switches (`lib/landing/landing-flags.ts`): an answer whose capabilities are switched off is left out, and the sign-up
// grant is mentioned only while `signupGrant` is on. The founder answers always stay out (they depend on the live seat count).
const flags = () => ({ ...resolveLandingFlags(), founder: false });

/** The landing FAQ's questions and answers for these ids (never written a second time), minus the ones switched off. */
export function landingFaq(...ids: string[]): { question: string; answer: string }[] {
  const items = LANDING_FAQ.flatMap(group => group.items);
  return ids.flatMap(id => {
    const item = items.find(entry => entry.id === id);
    if (!item) throw new Error(`landing FAQ ${id} not found`);
    return allOn(flags(), item.needs) ? [{ question: item.question, answer: faqAnswerText(item) }] : [];
  });
}

/** Whether public pages may say that a new account gets credits (the landing page's `signupGrant` switch). */
export function signupGrantShown(): boolean {
  return flags().signupGrant;
}
