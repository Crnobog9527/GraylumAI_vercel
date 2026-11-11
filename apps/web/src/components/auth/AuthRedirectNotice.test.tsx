/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthRedirectNotice } from './AuthRedirectNotice';

const render = (target: string) => renderToStaticMarkup(createElement(AuthRedirectNotice, { target }));

describe('login return notice', () => {
  it('names the picked plan for a landing-page buy link', () => {
    const markup = render('/app/profile?tab=subscription&buy=gold&cycle=monthly');
    expect(markup).toContain('Gold 月付');
    expect(markup).toContain('付款确认');
    expect(markup).not.toContain('buy=gold');
  });

  it('says in words that login continues to the page the visitor was opening, never its address, and nothing for the default', () => {
    for (const target of ['/app/positioning', '/app/library?tab=documents', '/app/profile?buy=platinum&cycle=monthly']) {
      const markup = render(target);
      expect(markup).toContain('登录后会直接带你去刚才要打开的页面');
      expect(markup).not.toContain('/app/');
      expect(markup).not.toContain('font-mono');
    }
    expect(render('/app/profile')).toBe('');
  });
});
