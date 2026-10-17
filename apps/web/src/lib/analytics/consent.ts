/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * The visitor's consent as Termly reports it (ANALYTICS plan §3.4). Termly alone decides, by its regional
 * rules, whether statistics may run: opt-in regions need an explicit yes, others are allowed until the visitor
 * refuses (or sends GPC). We never guess the region and never store a choice of our own. Every check reads
 * Termly's live state, so a withdrawal stops reporting at once.
 */
type TermlyConsentState = Partial<Record<'essential' | 'performance' | 'analytics' | 'advertising', boolean>>;

type TermlyApi = {
  getConsentState?: () => TermlyConsentState | null | undefined;
  on?: (event: 'initialized' | 'consent', callback: () => void) => void;
};

declare global {
  interface Window {
    Termly?: TermlyApi;
    displayPreferenceModal?: () => void;
  }
}

export type ConsentSnapshot = { analytics: boolean; advertising: boolean };

const DENIED: ConsentSnapshot = { analytics: false, advertising: false };
const listeners = new Set<() => void>();
let snapshot: ConsentSnapshot = DENIED;

/** Termly's live answer; anything missing or unreadable counts as no consent. */
export function readTermlyConsent(): ConsentSnapshot {
  if (typeof window === 'undefined') return DENIED;
  try {
    const state = window.Termly?.getConsentState?.();
    return { analytics: state?.analytics === true, advertising: state?.advertising === true };
  } catch {
    return DENIED;
  }
}

export function analyticsAllowed(): boolean {
  return readTermlyConsent().analytics;
}

/** Re-read Termly and tell subscribers when the answer changed. */
export function refreshConsent(): void {
  const next = readTermlyConsent();
  if (next.analytics === snapshot.analytics && next.advertising === snapshot.advertising) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function consentSnapshot(): ConsentSnapshot {
  return snapshot;
}

export function serverConsentSnapshot(): ConsentSnapshot {
  return DENIED;
}

/** Called from the Termly script's onload: follow its initialisation and every later consent change. */
export function attachTermly(): void {
  const termly = typeof window === 'undefined' ? undefined : window.Termly;
  termly?.on?.('initialized', refreshConsent);
  termly?.on?.('consent', refreshConsent);
  refreshConsent();
}

/** Opens Termly's preference centre (footer "Cookie settings" / "Do not sell or share"). */
export function openConsentPreferences(): boolean {
  if (typeof window === 'undefined' || typeof window.displayPreferenceModal !== 'function') return false;
  window.displayPreferenceModal();
  return true;
}
