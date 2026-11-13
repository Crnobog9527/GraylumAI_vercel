/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideUnauthorizedAction } from '@/lib/auth-recovery';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ createClient: () => ({ auth: { signOut: mocks.signOut } }) }));

type Shown = (event: { persisted: boolean }) => void;
let location: { href: string; origin: string };
let shown: Shown[];
/** The module afresh: whether a sign-out is under way is the page's state, and each test is a page of its own. */
const load = async () => { vi.resetModules(); return import('./sign-out'); };

beforeEach(() => {
  vi.clearAllMocks();
  location = { href: 'https://app.example.test/app/positioning/draft-1', origin: 'https://app.example.test' };
  shown = [];
  vi.stubGlobal('window', { location, addEventListener: (type: string, listener: Shown) => { if (type === 'pageshow') shown.push(listener); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('退出 on a signed-in page', () => {
  it('signs out, then goes to the home page; from the first moment the page counts as signing out', async () => {
    const { isSigningOut, signOutToHome } = await load();
    let during: boolean | null = null;
    mocks.signOut.mockImplementation(async () => { during = isSigningOut(); return { error: null }; });
    expect(isSigningOut()).toBe(false);
    expect(await signOutToHome()).toBe(true);
    // Supabase tells the provider "signed out" before it answers the caller: the mark has to be up by then.
    expect(during).toBe(true);
    expect(new URL(location.href).pathname).toBe('/');
    expect(location.href).not.toContain('login');
    // Still on: the page is leaving, and the refusals that arrive meanwhile are its own doing.
    expect(isSigningOut()).toBe(true);
  });

  it('a second press while one is under way does nothing', async () => {
    const { signOutToHome } = await load();
    let finish: (value: { error: null }) => void = () => undefined;
    mocks.signOut.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = signOutToHome();
    expect(await signOutToHome()).toBe(false);
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
    finish({ error: null });
    expect(await first).toBe(true);
  });

  it('a sign-out that could not be carried out leaves the page where it is, recovering from refusals as usual, and can be tried again', async () => {
    const { isSigningOut, signOutToHome } = await load();
    mocks.signOut.mockRejectedValueOnce(new Error('offline'));
    expect(await signOutToHome()).toBe(false);
    expect(location.href).toBe('https://app.example.test/app/positioning/draft-1');
    expect(isSigningOut()).toBe(false);
    mocks.signOut.mockResolvedValueOnce({ error: null });
    expect(await signOutToHome()).toBe(true);
  });

  it('the page shown again from the browser\'s back cache is a signed-in page like any other', async () => {
    const { isSigningOut, signOutToHome } = await load();
    mocks.signOut.mockResolvedValue({ error: null });
    await signOutToHome();
    expect(shown).toHaveLength(1);
    shown[0]!({ persisted: false });
    expect(isSigningOut()).toBe(true);
    shown[0]!({ persisted: true });
    expect(isSigningOut()).toBe(false);
  });
});

describe('a call refused as not signed in while the page is signing out', () => {
  const refused = { pathname: '/app/positioning/draft-1', search: '', hasSession: false, sessionRefreshUsed: false, lastRedirectAt: null, now: 1_000_000 };

  it('is left alone: no trip to the login page, no notice, no refresh', () => {
    // Without the mark this is the move that took the Owner to the login page (2026-11-13).
    expect(decideUnauthorizedAction(refused)).toEqual({ kind: 'redirect', to: '/login?redirect=%2Fapp%2Fpositioning%2Fdraft-1' });
    expect(decideUnauthorizedAction({ ...refused, signingOut: true })).toEqual({ kind: 'ignore' });
    for (const pathname of ['/app', '/app/profile', '/app/chats', '/admin']) {
      expect(decideUnauthorizedAction({ ...refused, pathname, signingOut: true }), pathname).toEqual({ kind: 'ignore' });
    }
    // Whatever else is true of the session at that moment.
    expect(decideUnauthorizedAction({ ...refused, hasSession: true, signingOut: true })).toEqual({ kind: 'ignore' });
    expect(decideUnauthorizedAction({ ...refused, lastRedirectAt: 999_000, signingOut: true })).toEqual({ kind: 'ignore' });
  });

  it('the recovery reads the mark, after it has looked the session up', () => {
    const source = readFileSync(fileURLToPath(new URL('../hooks/use-unauthorized-recovery.ts', import.meta.url)), 'utf8');
    expect(source.indexOf('signingOut: isSigningOut()')).toBeGreaterThan(source.indexOf('supabase.auth.getUser()'));
  });
});

describe('every 退出 of the signed-in pages is this one', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  // The rail's profile panel (conversation pages), the profile center's menu and its phone list (one hook), the old header.
  const WAYS_OUT = ['../components/opc/workspace-frame.tsx', '../components/profile/profile-menu.ts', '../components/layout/AppHeader.tsx'];

  it('the three places that sign a person out of a signed-in page call signOutToHome and do not sign out or pick an address themselves', () => {
    for (const path of WAYS_OUT) {
      const source = read(path);
      expect(source, path).toContain('signOutToHome()');
      expect(source, path).not.toMatch(/auth\s*\.\s*signOut\s*\(/);
      expect(source, path).not.toMatch(/location\.(?:href|assign|replace)[^\n]*(?:login|buildAppHref)/);
    }
    // The menu and the phone's list of the profile center both use the one hook.
    expect(read('../components/profile/ProfileSidebar.tsx')).toContain('useProfileLogout');
    expect(read('../components/profile/ProfileMobileHub.tsx')).toContain('useProfileLogout');
  });
});
