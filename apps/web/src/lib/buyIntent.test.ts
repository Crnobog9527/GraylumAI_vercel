/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { buyIntentFromTarget, buyIntentPath, describeBuyIntent, parseBuyIntent } from './buyIntent';

const read = (query: string) => parseBuyIntent(new URLSearchParams(query));

describe('landing-page buy intent', () => {
  it('reads only listed plan, cycle and offer values', () => {
    expect(read('buy=gold&cycle=monthly')).toEqual({ level: 'gold', cycle: 'monthly' });
    expect(read('buy=pro&cycle=yearly&offer=standard')).toEqual({ level: 'pro', cycle: 'yearly', offer: 'standard' });
    expect(read('buy=gold&cycle=monthly&offer=gold_first30')).toEqual({ level: 'gold', cycle: 'monthly', offer: 'gold_first30' });
    for (const query of ['', 'buy=gold', 'cycle=monthly', 'buy=free&cycle=monthly', 'buy=GOLD&cycle=monthly',
      'buy=gold&cycle=weekly', 'buy=gold%20&cycle=monthly', 'buy=https://evil.example&cycle=monthly']) {
      expect(read(query), query).toBeNull();
    }
  });

  it('drops an unknown offer instead of passing it on', () => {
    for (const offer of ['free', 'gold_first30x', '<script>', '0']) {
      expect(read(`buy=gold&cycle=monthly&offer=${encodeURIComponent(offer)}`)).toEqual({ level: 'gold', cycle: 'monthly' });
    }
  });

  it('rebuilds the membership link from the allowed values only', () => {
    expect(buyIntentPath({ level: 'gold', cycle: 'monthly' })).toBe('/profile?tab=subscription&buy=gold&cycle=monthly');
    expect(buyIntentPath({ level: 'pro', cycle: 'yearly', offer: 'founder' }))
      .toBe('/profile?tab=subscription&buy=pro&cycle=yearly&offer=founder');
  });

  it('finds the intent only in a membership-page return path', () => {
    expect(buyIntentFromTarget('/profile?tab=subscription&buy=gold&cycle=monthly')).toEqual({ level: 'gold', cycle: 'monthly' });
    expect(buyIntentFromTarget('/profile?buy=pro&cycle=yearly#plans')).toEqual({ level: 'pro', cycle: 'yearly' });
    for (const target of ['/profile', '/profilex?buy=gold&cycle=monthly', '/admin?buy=gold&cycle=monthly',
      '/profile/x?buy=gold&cycle=monthly', '/profile?buy=gold', '/profile#?buy=gold&cycle=monthly']) {
      expect(buyIntentFromTarget(target), target).toBeNull();
    }
  });

  it('names the plan for the login page', () => {
    expect(describeBuyIntent({ level: 'gold', cycle: 'monthly' })).toBe('Gold 月付');
    expect(describeBuyIntent({ level: 'pro', cycle: 'yearly' })).toBe('Pro 年付');
  });
});
