export const ANNOUNCEMENT_LINK_ERROR =
  '跳转链接仅支持有效的 https:// 外部地址或以单个 / 开头的站内路径，不能只填空白。';

const INTERNAL_BASE = 'https://announcement.invalid';

/** Shared by announcement writes and rendering; never resolves against user input. */
export function resolveAnnouncementLink(value?: string | null): {
  href: string;
  isExternal: boolean;
} | null {
  // Browsers strip controls and treat backslashes as slashes in special URLs.
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
  const href = value.trim();
  if (!href) return null;

  try {
    if (href.startsWith('/') && !href.startsWith('//')) {
      const parsed = new URL(href, INTERNAL_BASE);
      // Dot-segment normalization must not turn a path into a protocol-relative URL.
      if (parsed.origin !== INTERNAL_BASE || parsed.pathname.startsWith('//')) return null;
      return { href: `${parsed.pathname}${parsed.search}${parsed.hash}`, isExternal: false };
    }
    if (!/^https:\/\//i.test(href) || href[8] === '/') return null;
    const parsed = new URL(href);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
    return { href: parsed.href, isExternal: true };
  } catch {
    return null;
  }
}
