const TRPC_MAINTENANCE_PUBLIC_ALLOWLIST = new Set([
  'settings.getSystemSettings',
]);

export function parseTrpcProcedurePaths(pathname: string): string[] {
  const normalizedPathname = pathname.startsWith('/api/trpc/')
    ? pathname.slice('/api/trpc/'.length)
    : pathname.replace(/^\/+/, '');

  if (!normalizedPathname) {
    return [];
  }

  return normalizedPathname
    .split(',')
    .map((path) => {
      try {
        return decodeURIComponent(path).trim();
      } catch {
        return path.trim();
      }
    })
    .filter(Boolean);
}

export function isTrpcRequestAllowedDuringMaintenance(procedurePaths: string[]): boolean {
  if (procedurePaths.length === 0) {
    return false;
  }

  return procedurePaths.every((path) => TRPC_MAINTENANCE_PUBLIC_ALLOWLIST.has(path));
}
