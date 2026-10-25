/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as undefined | { language: string },
  options: {} as { onSuccess?: () => unknown; onError?: () => unknown },
  invalidate: vi.fn(),
  clicks: new Map<string, () => void>(),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...rest }: { children: string; onClick?: () => void } & Record<string, unknown>) => {
    if (onClick) state.clicks.set(String(children), onClick);
    return <button type="button" {...rest}>{children}</button>;
  },
}));
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ user: { getUserProfile: { invalidate: state.invalidate } } }),
    user: { setReplyLanguage: { useMutation: (options: typeof state.options) => {
      state.options = options;
      return { mutate: state.mutate, isPending: state.isPending, variables: state.variables };
    } } },
  },
}));

const { ReplyLanguageCard } = await import('./ReplyLanguageCard');

beforeEach(() => {
  state.mutate = vi.fn(); state.isPending = false; state.variables = undefined; state.invalidate = vi.fn(); state.clicks.clear();
});

describe('reply language card (CHAT-LANGUAGE)', () => {
  it('offers the three languages in their own script, marks the current one and says it only affects AI replies', () => {
    const html = renderToStaticMarkup(<ReplyLanguageCard language="zh-Hant" />);
    for (const label of ['简体中文', '繁體中文', 'English']) expect(html).toContain(label);
    expect(html).toMatch(/aria-checked="true"[^>]*>繁體中文/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain('目前只影响 AI 回复语言，网站界面仍是简体中文');
    expect(html).toContain('明确要别的语言时，那一次按你的要求');
  });

  it('saves another language, refreshes the profile, and does nothing for the current one', async () => {
    renderToStaticMarkup(<ReplyLanguageCard language="zh-Hans" />);
    state.clicks.get('简体中文')!();
    expect(state.mutate).not.toHaveBeenCalled();
    state.clicks.get('English')!();
    expect(state.mutate).toHaveBeenCalledWith({ language: 'en' });
    await state.options.onSuccess?.();
    expect(state.invalidate).toHaveBeenCalled();
  });

  it('shows the language being saved and locks the choice while it saves', () => {
    state.isPending = true; state.variables = { language: 'en' };
    const html = renderToStaticMarkup(<ReplyLanguageCard language="zh-Hans" />);
    expect(html).toMatch(/aria-checked="true"[^>]*>English/);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).toContain('正在保存');
  });
});
