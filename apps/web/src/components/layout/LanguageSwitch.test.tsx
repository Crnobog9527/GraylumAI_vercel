/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profile: { data: { reply_language: 'zh-Hans' } } as { data?: { reply_language: string } },
  mutate: vi.fn(), isPending: false, variables: undefined as undefined | { language: string },
  onValueChange: undefined as undefined | ((value: string) => void),
}));
vi.mock('@/components/ui/dropdown-menu', () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    DropdownMenu: pass, DropdownMenuTrigger: pass, DropdownMenuContent: pass, DropdownMenuLabel: pass,
    DropdownMenuRadioGroup: ({ children, value, onValueChange }: { children: ReactNode; value: string; onValueChange: (v: string) => void }) => {
      state.onValueChange = onValueChange;
      return <div role="radiogroup" data-value={value}>{children}</div>;
    },
    DropdownMenuRadioItem: ({ children, value, disabled }: { children: ReactNode; value: string; disabled?: boolean }) =>
      <div role="menuitemradio" data-value={value} aria-disabled={disabled}>{children}</div>,
  };
});
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ user: { getUserProfile: { invalidate: vi.fn() } } }),
    user: {
      getUserProfile: { useQuery: () => state.profile },
      setReplyLanguage: { useMutation: () => ({ mutate: state.mutate, isPending: state.isPending, variables: state.variables }) },
    },
  },
}));

const { LanguageSwitch } = await import('./LanguageSwitch');

beforeEach(() => {
  state.profile = { data: { reply_language: 'zh-Hans' } }; state.mutate = vi.fn(); state.isPending = false; state.variables = undefined;
});

describe('top-bar language switch (CHAT-LANGUAGE, Owner 2026-10-25)', () => {
  it('shows the current language and offers the three, saying it only affects AI replies for now', () => {
    state.profile = { data: { reply_language: 'zh-Hant' } };
    const html = renderToStaticMarkup(<LanguageSwitch />);
    expect(html).toContain('aria-label="语言：繁體中文"');
    expect(html).toContain('data-value="zh-Hant"');
    for (const label of ['简体中文', '繁體中文', 'English']) expect(html).toContain(label);
    expect(html).toContain('目前只影响 AI 回复语言');
  });

  it('saves the same setting as the profile card, and ignores the current or an unknown value', () => {
    renderToStaticMarkup(<LanguageSwitch />);
    state.onValueChange!('zh-Hans');
    state.onValueChange!('fr');
    expect(state.mutate).not.toHaveBeenCalled();
    state.onValueChange!('en');
    expect(state.mutate).toHaveBeenCalledWith({ language: 'en' });
  });

  it('shows the language being saved and locks the choices meanwhile; renders nothing before the profile is read', () => {
    state.isPending = true; state.variables = { language: 'en' };
    const html = renderToStaticMarkup(<LanguageSwitch />);
    expect(html).toContain('aria-label="语言：English"');
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
    state.profile = {};
    state.isPending = false; state.variables = undefined;
    expect(renderToStaticMarkup(<LanguageSwitch />)).toBe('');
  });
});
