/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * The user's brands and their platform accounts, read from the existing library query (no new server read). A
 * connection always hangs on one of these accounts (plan §3.2); benchmarks hang on the brand.
 */
export type BrandAccount = { projectId: string; platform: string; label: string; businessId: string; businessName: string;
  items: Array<{ workItemId: string; title: string }> };
export type Brand = { businessId: string; name: string; accounts: BrandAccount[] };

type RawAccount = { projectId?: unknown; platform?: unknown; account?: unknown; displayName?: unknown;
  items?: Array<{ workItemId?: unknown; title?: unknown }> };
type RawBusiness = { businessId?: unknown; name?: unknown; accounts?: RawAccount[] };

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export function brandsFromLibrary(data: unknown): Brand[] {
  const businesses = (data as { businesses?: RawBusiness[] } | null | undefined)?.businesses;
  if (!Array.isArray(businesses)) return [];
  return businesses.filter(b => text(b.businessId)).map(b => {
    const businessId = text(b.businessId), name = text(b.name) || '未命名品牌';
    const accounts = (Array.isArray(b.accounts) ? b.accounts : []).filter(a => text(a.projectId) && text(a.platform))
      .map(a => ({ projectId: text(a.projectId), platform: text(a.platform), label: text(a.displayName) || text(a.account),
        businessId, businessName: name,
        items: (Array.isArray(a.items) ? a.items : []).filter(i => text(i.workItemId))
          .map(i => ({ workItemId: text(i.workItemId), title: text(i.title) || '未命名内容' })) }));
    return { businessId, name, accounts };
  });
}

export function accountIndex(brands: Brand[]): Map<string, BrandAccount> {
  return new Map(brands.flatMap(brand => brand.accounts.map(account => [account.projectId, account] as const)));
}
