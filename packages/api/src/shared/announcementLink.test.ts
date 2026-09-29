import { describe, expect, it } from 'vitest';
import { resolveAnnouncementLink } from './announcementLink';

describe('resolveAnnouncementLink', () => {
  it.each([
    ['https://example.com', 'https://example.com/', true],
    ['https://example.com/news?q=one#top', 'https://example.com/news?q=one#top', true],
    ['HTTPS://EXAMPLE.COM/news', 'https://example.com/news', true],
    ['  https://example.com/news  ', 'https://example.com/news', true],
    ['/', '/', false],
    ['/marketplace', '/marketplace', false],
    [' /news?q=one#top ', '/news?q=one#top', false],
    ['/news/../profile', '/profile', false],
    ['/search?q=https://example.com', '/search?q=https://example.com', false],
    ['/help/%E4%B8%AD%E6%96%87', '/help/%E4%B8%AD%E6%96%87', false],
  ])('allows %j', (input, href, isExternal) => {
    expect(resolveAnnouncementLink(input as string)).toEqual({ href, isExternal });
  });

  it.each([
    undefined, null, '', '   ', '\t\n',
    'javascript:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)',
    '//example.com', '/\\example.com', 'https:example.com',
    'http://example.com', 'ftp://example.com', 'mailto:test@example.com',
    'profile', '?page=1', '#top', 'https://', 'https:///', 'https:///example.com',
    'https://example.com:invalid', 'https://exa mple.com',
    'https://example.com\\evil', '/folder\\evil', '/.//example.com',
    '/folder/..//example.com', '/%2e//example.com',
    '/\n/example.com', '/\r/example.com', '/\t/example.com', '/\0/example.com',
    '\nhttps://example.com', 'https://example.com\n', 'https://exa\tmple.com',
  ])('rejects %j', input => {
    expect(resolveAnnouncementLink(input)).toBeNull();
  });
});
