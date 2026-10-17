/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthRedirectNotice } from './AuthRedirectNotice';

const render = (target: string) => renderToStaticMarkup(createElement(AuthRedirectNotice, { target }));

describe('login return notice', () => {
  it('names the picked plan for a landing-page buy link', () => {
    const markup = render('/profile?tab=subscription&buy=gold&cycle=monthly');
    expect(markup).toContain('Gold 月付');
    expect(markup).toContain('付款确认');
    expect(markup).not.toContain('buy=gold');
  });

  it('shows the plain return path otherwise and nothing for the default', () => {
    expect(render('/positioning')).toContain('登录完成后将返回 <span class="font-mono">/positioning</span>');
    expect(render('/profile?buy=platinum&cycle=monthly')).toContain('登录完成后将返回');
    expect(render('/profile')).toBe('');
  });
});
