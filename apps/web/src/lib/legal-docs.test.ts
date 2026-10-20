/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { readLegalDoc, type LegalDocName } from './legal-docs';

const NAMES: LegalDocName[] = ['privacy', 'terms', 'cookies', 'refund-policy'];

describe('legal documents', () => {
  it.each(NAMES)('%s is complete: no blanks, no staging domain, company details present', name => {
    const html = readLegalDoc(name);
    expect(html).not.toMatch(/_{4,}/);
    expect(html).not.toContain('auth-staging');
    expect(html).toContain('support@graylum.com');
    expect(html).toContain('75 E 3rd St');
    expect(html).toContain('Sheridan, WY 82801');
    expect(html).not.toMatch(/<script/i);
  });

  it('terms: Wyoming courts, 6 month liability cap, subscriptions and refunds are written down', () => {
    const html = readLegalDoc('terms');
    for (const text of ['Sheridan County, Wyoming', 'SIX (6) MONTH PERIOD', 'automatically renew', 'at least 18 years old',
      'https://www.graylum.com/refund-policy', 'Data Use Consent', 'YOUR CONTENT AND AI OUTPUTS', '<h2 id="sec-7">7. PROHIBITED ACTIVITIES</h2>']) {
      expect(html).toContain(text);
    }
  });

  it('terms: the forum-style content licence that would cover private chats is not there', () => {
    const html = readLegalDoc('terms');
    for (const text of ['Contributions', 'resell, publish', 'perpetual', 'arbitration', 'friend lists']) {
      expect(html).not.toContain(text);
    }
  });

  it('refund policy follows the Master Plan refund rules (item 51)', () => {
    const html = readLegalDoc('refund-policy');
    for (const text of ['seven (7) days', 'None of the credits', 'Automatic renewal charges', 'support ticket', 'fixed 6%',
      'Credits do not expire', 'founder status ends immediately']) {
      expect(html).toContain(text);
    }
  });

  it('privacy: states the real sign-in provider, no sale of data, and the corrected categories', () => {
    const html = readLegalDoc('privacy');
    expect(html).toContain('Google account');
    expect(html).not.toContain('Facebook');
    expect(html).toContain('we have not sold or shared personal information');
    expect(html).toContain('<td>C. Protected classification characteristics under state or federal law</td><td>');
    expect(html).toMatch(/F\. Internet or other similar network activity<\/td><td>[^<]+<\/td><td>YES/);
    expect(html).toMatch(/C\. Protected classification[^<]*<\/td><td>[^<]+<\/td><td>NO/);
  });

  it.each(['privacy', 'terms'] as const)('%s: the table of contents links to every section and section ids are unique', name => {
    const html = readLegalDoc(name);
    const ids = [...html.matchAll(/<h2 id="sec-(\d+)">/g)].map(match => match[1]);
    const toc = html.match(/<ol class="toc">([\s\S]*?)<\/ol>/)?.[1] ?? '';
    const links = [...toc.matchAll(/href="#sec-(\d+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(links.length).toBeGreaterThan(15);
    expect(links.every(link => ids.includes(link))).toBe(true);
  });

  it('cookies: lists the first-touch storage under analytics', () => {
    expect(readLegalDoc('cookies')).toContain('graylum.analytics.first-touch');
  });
});
