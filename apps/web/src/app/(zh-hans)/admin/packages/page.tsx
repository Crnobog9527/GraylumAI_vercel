'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Package, Crown } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { toast } from '@/components/ui/sonner';
import type { CreditPackage, MembershipPlan } from './packagesShared';
import { useCreditPackageAdmin } from './useCreditPackageAdmin';
import { useMembershipPlanAdmin } from './useMembershipPlanAdmin';
import { CreditPackagesTab } from './CreditPackagesTab';
import { MembershipPlansTab } from './MembershipPlansTab';
import { CreditPackageDialog } from './CreditPackageDialog';
import { MembershipPlanDialog } from './MembershipPlanDialog';

export default function AdminPackagesPage() {
  const [activeTab, setActiveTab] = useState('credit-packages');

  // Queries
  const { data: dashboard, isLoading: dashboardLoading, error: dashboardError, refetch: refetchDashboard } = trpc.admin.getPackagesDashboard.useQuery();
  const packages = dashboard?.packages;
  const membershipPlans = dashboard?.membershipPlans;

  const refreshPackagesDashboard = (fallback = '数据已保存，但列表刷新失败，请手动刷新页面确认。') => {
    void refetchDashboard()
      .then((result) => {
        if (result.error) {
          toast.error(getSafeErrorMessage(result.error, fallback));
        }
      })
      .catch((error) => {
        toast.error(getSafeErrorMessage(error, fallback));
      });
  };

  const creditPackageAdmin = useCreditPackageAdmin(refreshPackagesDashboard);
  const membershipPlanAdmin = useMembershipPlanAdmin(refreshPackagesDashboard);

  // Loading state
  if (dashboardLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  const error = dashboardError;
  if (error) {
    return <AdminErrorState error={error} onRetry={() => { refetchDashboard(); }} />;
  }

  const packageList = packages ?? [];
  const planList = (membershipPlans ?? []) as MembershipPlan[];
  const activePackageCount = packageList.filter((p: CreditPackage) => p.active === 'true').length;
  const activePlanCount = planList.filter((p: MembershipPlan) => p.is_active === 'true').length;

  return (
    <div className="space-y-6 p-4 md:p-8">
      {/* Page Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>
              套餐管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理积分包和会员等级
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList
            className="mb-2 flex h-auto justify-start gap-1 overflow-x-auto p-1"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <TabsTrigger
              value="credit-packages"
              className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
            >
              <Package className="h-4 w-4 mr-2" />
              积分包
            </TabsTrigger>
            <TabsTrigger
              value="membership-plans"
              className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
            >
              <Crown className="h-4 w-4 mr-2" />
              会员等级
            </TabsTrigger>
          </TabsList>

          <CreditPackagesTab packageList={packageList} activePackageCount={activePackageCount} admin={creditPackageAdmin} />
          <MembershipPlansTab planList={planList} activePlanCount={activePlanCount} admin={membershipPlanAdmin} />
        </Tabs>

        <CreditPackageDialog admin={creditPackageAdmin} />
        <MembershipPlanDialog admin={membershipPlanAdmin} />
    </div>
  );
}
