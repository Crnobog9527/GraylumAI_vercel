import { describe, expect, it } from 'vitest';
import { asRequiredLevel, meetsMemberLevel } from './memberOnly';

describe('member-only module levels', () => {
  it('a module with no requirement is open to every plan, an unknown plan included', () => {
    for (const level of ['free', 'pro', 'gold', null, undefined, 'weird']) expect(meetsMemberLevel(level, null)).toBe(true);
  });
  it('"pro" is met by Pro and Gold, not by free, an unknown plan or no plan', () => {
    expect(meetsMemberLevel('pro', 'pro')).toBe(true);
    expect(meetsMemberLevel('gold', 'pro')).toBe(true);
    for (const level of ['free', null, undefined, 'weird']) expect(meetsMemberLevel(level, 'pro')).toBe(false);
  });
  it('"gold" is met by Gold only; an unknown requirement is never met', () => {
    expect(meetsMemberLevel('gold', 'gold')).toBe(true);
    expect(meetsMemberLevel('pro', 'gold')).toBe(false);
    expect(meetsMemberLevel('gold', 'platinum')).toBe(false);
  });
  it('only pro and gold are read as a requirement', () => {
    expect(asRequiredLevel('pro')).toBe('pro');
    expect(asRequiredLevel('gold')).toBe('gold');
    for (const value of ['free', '', null, undefined, 'x', 1]) expect(asRequiredLevel(value)).toBeNull();
  });
});
