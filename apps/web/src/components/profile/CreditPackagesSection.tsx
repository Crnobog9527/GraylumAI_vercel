/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { memo } from 'react';
import { Package, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trpc } from '@/trpc/client';
import { CreditPackagePriceTag } from './creditPackagePrice';
import { ProfileCatalogState } from './ProfileCatalogState';
import { PACK_MEMBERS_ONLY_NOTICE, creditPackBuyState, isPaidMember, type PackEntitlement } from './creditPackageGate';

// 积分加油包区块
export const CreditPackagesSection = memo(function CreditPackagesSection({
  onBuyClick, pendingPackageId,
}: {
  onBuyClick?: (pkg: { id: string; name?: string; credits: number; bonus_credits: number; price: number; checkout_ready?: boolean }) => void;
  pendingPackageId?: string | null;
}) {
  // 从 API 获取积分加油包数据
  const {
    data: packages = [],
    isLoading,
    isError,
    isFetching,
    refetch,
  } = trpc.settings.getCreditPackages.useQuery();
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { staleTime: 30_000 });
  const entitlement: PackEntitlement = entitlements.isError ? { status: 'error' }
    : entitlements.data ? { status: 'ready', level: entitlements.data.level } : { status: 'loading' };
  // The discount follows the same server level as the buy button; until it is known, list prices only.
  const priceLevel = entitlement.status === 'ready' ? entitlement.level : null;

  return (
    <div
      className="mt-6 rounded-2xl p-6 md:p-8"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex items-center gap-3 mb-6">
        <div
          className="p-2 rounded-lg"
          style={{ background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.2)' }}
        >
          <Package className="h-5 w-5" style={{ color: 'rgba(139, 92, 246, 1)' }} />
        </div>
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>积分加油包</h3>
      </div>
      {entitlement.status === 'ready' && !isPaidMember(entitlement) && (
        <p data-testid="profile-credit-packages-members-only" className="mb-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          {PACK_MEMBERS_ONLY_NOTICE}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {isLoading ? (
          <div className="col-span-4 text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            加载中...
          </div>
        ) : isError ? (
          <ProfileCatalogState
            status="unavailable"
            retrying={isFetching}
            onRetry={() => { void refetch(); }}
          />
        ) : packages.length === 0 ? (
          <ProfileCatalogState status="empty" />
        ) : packages.map((pkg) => {
          const buy = creditPackBuyState({ price: pkg.price, checkoutReady: pkg.checkout_ready,
            pending: pendingPackageId === pkg.id, entitlement });
          return (
          <div
            key={pkg.id}
            data-testid={`profile-credit-package-${pkg.id}`}
            className="relative rounded-xl p-4 text-center transition-colors duration-200"
            style={{
              background: 'var(--bg-primary)',
              border: pkg.is_popular ? '2px solid rgba(59, 130, 246, 0.5)' : '1px solid var(--border-primary)',
              boxShadow: pkg.is_popular ? '0 0 20px rgba(59, 130, 246, 0.2)' : 'none'
            }}
          >
            {pkg.is_popular && (
              <div
                className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full text-xs font-medium"
                style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#3B82F6', border: '1px solid rgba(59, 130, 246, 0.3)' }}
              >
                热门
              </div>
            )}
            <div className="flex items-center justify-center gap-1 mb-2 mt-2">
              <Zap className="h-5 w-5" style={{ color: 'var(--color-primary)' }} />
              <span
                className="text-2xl font-bold"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent'
                }}
              >
                {pkg.credits.toLocaleString()}
              </span>
            </div>
            {pkg.bonus_credits > 0 && (
              <div className="text-xs mb-2" style={{ color: 'var(--success)' }}>
                +{pkg.bonus_credits} 赠送
              </div>
            )}
            <CreditPackagePriceTag listUsd={pkg.price} membershipLevel={priceLevel} />
            <div
              data-testid="profile-credit-package-name"
              className="text-sm font-medium mb-3"
              style={{ color: 'var(--text-primary)' }}
            >
              {'name' in pkg && typeof pkg.name === 'string' ? pkg.name : `${pkg.credits.toLocaleString()} 积分包`}
            </div>
            <Button
              onClick={() => { if (!buy.disabled) onBuyClick?.(pkg); }}
              size="sm"
              disabled={buy.disabled}
              className="w-full gap-2"
              style={{
                background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                color: 'var(--bg-primary)'
              }}
            >
              {buy.label}
            </Button>
          </div>
          );
        })}
      </div>
    </div>
  );
});
