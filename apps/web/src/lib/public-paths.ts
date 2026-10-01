// Paths anyone may open without logging in. Shared by the proxy (server) and the client-side
// 401 recovery, which must never send a visitor on one of these pages to the login page.
export const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/verify-email',
  '/maintenance',
  '/contact',
  '/tutorials',
  '/faq',
  '/terms',
  '/privacy',
  '/acceptable-use',
  '/auth',
  '/landing',
  '/api',
  '/_next',
  '/_vercel',
  '/favicon.ico',
];

export function isPublicPathname(pathname: string): boolean {
  return PUBLIC_PATHS.some(path => pathname.startsWith(path));
}
