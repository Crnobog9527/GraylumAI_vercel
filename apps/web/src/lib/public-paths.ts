// Paths anyone may open without logging in. Shared by the proxy (server) and the client-side
// 401 recovery, which must never send a visitor on one of these pages to the login page.
export const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/verify-email',
  '/forgot-password',
  // Needs a session from a reset link; the page itself checks it instead of sending visitors to login.
  '/reset-password',
  '/maintenance',
  '/contact',
  '/faq',
  '/terms',
  '/privacy',
  '/acceptable-use',
  // The refund policy is public like the terms (Owner 2026-10-17); its page is published separately.
  '/refund',
  // The accessibility statement (WCAG 2.1 AA goal, known limits, feedback email).
  '/accessibility',
  // Public site pages (PUBLIC-SITE, SEO_GEO_SPEC 3.2): About and the Traditional Chinese (Taiwan) section.
  '/about',
  '/zh-tw',
  // Product feature pages linked from the public header and footer (PUBLIC-SITE): /features and /features/<name>.
  '/features',
  // The tutorial blog (SEO_GEO_SPEC 14): /blog and /blog/<article>, linked from the public header as 教程.
  '/blog',
  // The public pricing page (moved from /landing/pricing, 2026-10-18).
  '/pricing',
  // The founder members' wall: read-only, shows only cards the member agreed to publish and an admin approved.
  '/founders',
  '/auth',
  '/landing',
  '/api',
  '/_next',
  '/_vercel',
  '/favicon.ico',
];

export function isPublicPathname(pathname: string): boolean {
  // Whole path segments only, so /login-anything is not public just because /login is.
  return PUBLIC_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`));
}
