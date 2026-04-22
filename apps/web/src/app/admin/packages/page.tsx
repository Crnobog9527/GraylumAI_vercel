'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Package, Plus, Pencil, Trash2, Check, X,
  DollarSign, Coins, Crown, Star, Flame, Gift, ArrowUpDown
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';
import { formatUsdFromCents } from '@/lib/currency';

interface CreditPackage {
  id: string;
  name: string;
  price: number;
  credits_amount: number;
  bonus_credits: number;
  stripe_price_id?: string | null;
  sort_order: number;
  is_popular: string;
  active: string;
  created_at: string;
}

interface MembershipPlan {
  id: string;
  name: string;
  level: 'free' | 'pro' | 'gold';
  monthly_price: number;
  yearly_price: number;
  stripe_monthly_price_id?: string | null;
  stripe_yearly_price_id?: string | null;
  monthly_credits: number;
  yearly_credits: number;
  monthly_bonus_credits: number;
  package_discount: number;
  features: string[];
  max_context_messages: number;
  is_active: string;
  sort_order: number;
  created_at: string;
}

const levelColors = {
  free: { bg: 'bg-gray-500/20', text: 'text-gray-400', label: '免费版' },
  pro: { bg: 'bg-blue-500/20', text: 'text-blue-400', label: 'Pro 专业版' },
  gold: { bg: 'bg-amber-500/20', text: 'text-amber-400', label: 'Gold 黄金版' },
};

export default function AdminPackagesPage() {
  const [activeTab, setActiveTab] = useState('credit-packages');

  // Credit Package State
  const [packageDialogOpen, setPackageDialogOpen] = useState(false);
  const [editingPackage, setEditingPackage] = useState<CreditPackage | null>(null);
  const [packageFormData, setPackageFormData] = useState({
    name: '',
    price: '',
    creditsAmount: '',
    bonusCredits: '0',
    stripePriceId: '',
    sortOrder: '0',
    isPopular: 'false',
    active: 'true',
  });

  // Membership Plan State
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<MembershipPlan | null>(null);
  const [planFormData, setPlanFormData] = useState({
    name: '',
    level: 'pro' as 'free' | 'pro' | 'gold',
    monthlyPrice: '',
      yearlyPrice: '',
      stripeMonthlyPriceId: '',
      stripeYearlyPriceId: '',
      monthlyCredits: '',
      yearlyCredits: '',
      monthlyBonusCredits: '',
    packageDiscount: '100',
    maxContextMessages: '20',
    features: '',
    sortOrder: '0',
  });

  // Queries
  const { data: dashboard, isLoading: dashboardLoading, error: dashboardError, refetch: refetchDashboard } = trpc.admin.getPackagesDashboard.useQuery();
  const packages = dashboard?.packages;
  const membershipPlans = dashboard?.membershipPlans;

  // Credit Package Mutations
  const createPackage = trpc.admin.createPackage.useMutation({
    onSuccess: () => {
      refetchDashboard();
      closePackageDialog();
    }
  });

  const updatePackage = trpc.admin.updatePackage.useMutation({
    onSuccess: () => {
      refetchDashboard();
      closePackageDialog();
    }
  });

  const deletePackage = trpc.admin.deletePackage.useMutation({
    onSuccess: () => {
      refetchDashboard();
    }
  });

  // Membership Plan Mutations
  const createMembershipPlan = trpc.admin.createMembershipPlan.useMutation({
    onSuccess: () => {
      refetchDashboard();
      closePlanDialog();
    }
  });

  const updateMembershipPlan = trpc.admin.updateMembershipPlan.useMutation({
    onSuccess: () => {
      refetchDashboard();
      closePlanDialog();
    }
  });

  const deleteMembershipPlan = trpc.admin.deleteMembershipPlan.useMutation({
    onSuccess: () => {
      refetchDashboard();
    }
  });

  // Credit Package Handlers
  const openCreatePackageDialog = () => {
    setEditingPackage(null);
    setPackageFormData({
      name: '',
      price: '',
      creditsAmount: '',
      bonusCredits: '0',
      stripePriceId: '',
      sortOrder: '0',
      isPopular: 'false',
      active: 'true',
    });
    setPackageDialogOpen(true);
  };

  const openEditPackageDialog = (pkg: CreditPackage) => {
    setEditingPackage(pkg);
    setPackageFormData({
      name: pkg.name,
      price: (pkg.price / 100).toString(),
      creditsAmount: pkg.credits_amount.toString(),
      bonusCredits: (pkg.bonus_credits || 0).toString(),
      stripePriceId: pkg.stripe_price_id || '',
      sortOrder: (pkg.sort_order || 0).toString(),
      isPopular: pkg.is_popular || 'false',
      active: pkg.active || 'true',
    });
    setPackageDialogOpen(true);
  };

  const closePackageDialog = () => {
    setPackageDialogOpen(false);
    setEditingPackage(null);
    setPackageFormData({
      name: '',
      price: '',
      creditsAmount: '',
      bonusCredits: '0',
      stripePriceId: '',
      sortOrder: '0',
      isPopular: 'false',
      active: 'true',
    });
  };

  const handlePackageSubmit = () => {
    const priceInCents = Math.round(parseFloat(packageFormData.price) * 100);
    const creditsAmount = parseInt(packageFormData.creditsAmount);
    const bonusCredits = parseInt(packageFormData.bonusCredits || '0');
    const sortOrder = parseInt(packageFormData.sortOrder || '0');

    if (editingPackage) {
      updatePackage.mutate({
        id: editingPackage.id,
        name: packageFormData.name,
        price: priceInCents,
        creditsAmount,
        bonusCredits,
        stripePriceId: packageFormData.stripePriceId || undefined,
        sortOrder,
        isPopular: packageFormData.isPopular as 'true' | 'false',
        active: packageFormData.active as 'true' | 'false',
      });
    } else {
      createPackage.mutate({
        name: packageFormData.name,
        price: priceInCents,
        creditsAmount,
        bonusCredits,
        stripePriceId: packageFormData.stripePriceId || undefined,
        sortOrder,
        isPopular: packageFormData.isPopular as 'true' | 'false',
        active: packageFormData.active as 'true' | 'false',
      });
    }
  };

  const handlePackageToggleActive = (pkg: CreditPackage) => {
    updatePackage.mutate({
      id: pkg.id,
      active: pkg.active === 'true' ? 'false' : 'true',
    });
  };

  const handlePackageDelete = (pkg: CreditPackage) => {
    if (confirm(`确定要删除 "${pkg.name}" 吗？`)) {
      deletePackage.mutate({ id: pkg.id });
    }
  };

  // Membership Plan Handlers
  const openCreatePlanDialog = () => {
    setEditingPlan(null);
    setPlanFormData({
      name: '',
      level: 'pro',
      monthlyPrice: '',
      yearlyPrice: '',
      stripeMonthlyPriceId: '',
      stripeYearlyPriceId: '',
      monthlyCredits: '',
      yearlyCredits: '',
      monthlyBonusCredits: '0',
      packageDiscount: '100',
      maxContextMessages: '20',
      features: '',
      sortOrder: '0',
    });
    setPlanDialogOpen(true);
  };

  const openEditPlanDialog = (plan: MembershipPlan) => {
    setEditingPlan(plan);
    setPlanFormData({
      name: plan.name,
      level: plan.level,
      monthlyPrice: (plan.monthly_price / 100).toString(),
      yearlyPrice: (plan.yearly_price / 100).toString(),
      stripeMonthlyPriceId: plan.stripe_monthly_price_id || '',
      stripeYearlyPriceId: plan.stripe_yearly_price_id || '',
      monthlyCredits: plan.monthly_credits.toString(),
      yearlyCredits: plan.yearly_credits.toString(),
      monthlyBonusCredits: plan.monthly_bonus_credits.toString(),
      packageDiscount: plan.package_discount.toString(),
      maxContextMessages: (plan.max_context_messages || 20).toString(),
      features: (plan.features || []).join('\n'),
      sortOrder: plan.sort_order.toString(),
    });
    setPlanDialogOpen(true);
  };

  const closePlanDialog = () => {
    setPlanDialogOpen(false);
    setEditingPlan(null);
  };

  const handlePlanSubmit = () => {
    const data = {
      name: planFormData.name,
      level: planFormData.level,
      monthlyPrice: Math.round(parseFloat(planFormData.monthlyPrice || '0') * 100),
      yearlyPrice: Math.round(parseFloat(planFormData.yearlyPrice || '0') * 100),
      stripeMonthlyPriceId: planFormData.stripeMonthlyPriceId || undefined,
      stripeYearlyPriceId: planFormData.stripeYearlyPriceId || undefined,
      monthlyCredits: parseInt(planFormData.monthlyCredits || '0'),
      yearlyCredits: parseInt(planFormData.yearlyCredits || '0'),
      monthlyBonusCredits: parseInt(planFormData.monthlyBonusCredits || '0'),
      packageDiscount: parseInt(planFormData.packageDiscount || '100'),
      maxContextMessages: parseInt(planFormData.maxContextMessages || '20'),
      features: planFormData.features.split('\n').filter(f => f.trim()),
      sortOrder: parseInt(planFormData.sortOrder || '0'),
    };

    if (editingPlan) {
      updateMembershipPlan.mutate({
        id: editingPlan.id,
        ...data,
      });
    } else {
      createMembershipPlan.mutate(data);
    }
  };

  const handlePlanToggleActive = (plan: MembershipPlan) => {
    updateMembershipPlan.mutate({
      id: plan.id,
      isActive: plan.is_active === 'true' ? 'false' : 'true',
    });
  };

  const handlePlanDelete = (plan: MembershipPlan) => {
    if (confirm(`确定要删除 "${plan.name}" 吗？`)) {
      deleteMembershipPlan.mutate({ id: plan.id });
    }
  };

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
              管理积分加油包和会员等级
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
              积分加油包
            </TabsTrigger>
            <TabsTrigger
              value="membership-plans"
              className="shrink-0 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
            >
              <Crown className="h-4 w-4 mr-2" />
              会员等级
            </TabsTrigger>
          </TabsList>

          {/* Credit Packages Tab */}
          <TabsContent value="credit-packages" className="space-y-4">
            <div className="flex justify-end">
              <Button
                onClick={openCreatePackageDialog}
                data-testid="admin-credit-package-create-trigger"
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                <Plus className="h-4 w-4 mr-2" />
                创建积分包
              </Button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                      <Package className="h-6 w-6 text-[var(--color-primary)]" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总套餐数</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {packageList.length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-emerald-500/20">
                      <Check className="h-6 w-6 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已上架</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {activePackageCount}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-rose-500/20">
                      <X className="h-6 w-6 text-rose-400" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已下架</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {packageList.length - activePackageCount}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Packages Table */}
            <Card data-testid="admin-packages-credit-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>套餐名称</TableHead>
                      <TableHead>价格 (USD)</TableHead>
                      <TableHead>积分数量</TableHead>
                      <TableHead>赠送积分</TableHead>
                      <TableHead>Stripe</TableHead>
                      <TableHead>排序</TableHead>
                      <TableHead>标签</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="w-[120px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {packageList.map((pkg: CreditPackage) => (
                      <TableRow key={pkg.id} data-testid={`admin-credit-package-row-${pkg.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div
                              className="p-2 rounded-lg"
                              style={{ background: 'var(--bg-tertiary)' }}
                            >
                              <Package className="h-4 w-4 text-[var(--color-primary)]" />
                            </div>
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {pkg.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <DollarSign className="h-4 w-4 text-emerald-400" />
                            <span style={{ color: 'var(--text-primary)' }}>
                              {formatUsdFromCents(pkg.price)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Coins className="h-4 w-4 text-amber-400" />
                            <span style={{ color: 'var(--text-primary)' }}>
                              {pkg.credits_amount.toLocaleString()}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {(pkg.bonus_credits || 0) > 0 ? (
                            <div className="flex items-center gap-1">
                              <Gift className="h-4 w-4 text-pink-400" />
                              <span className="text-pink-400">
                                +{pkg.bonus_credits.toLocaleString()}
                              </span>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-disabled)' }}>-</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {pkg.stripe_price_id ? (
                            <Badge className="bg-emerald-500/20 text-emerald-400">已配置</Badge>
                          ) : (
                            <Badge className="bg-amber-500/20 text-amber-400">未配置</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <ArrowUpDown className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />
                            <span style={{ color: 'var(--text-secondary)' }}>
                              {pkg.sort_order || 0}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {pkg.is_popular === 'true' && (
                            <Badge className="bg-orange-500/20 text-orange-400">
                              <Flame className="h-3 w-3 mr-1" />
                              热门
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            data-testid={`admin-credit-package-toggle-${pkg.id}`}
                            className={pkg.active === 'true'
                              ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                              : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                            }
                            onClick={() => handlePackageToggleActive(pkg)}
                          >
                            {pkg.active === 'true' ? (
                              <>
                                <Check className="h-3 w-3 mr-1" />
                                已上架
                              </>
                            ) : (
                              <>
                                <X className="h-3 w-3 mr-1" />
                                已下架
                              </>
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              data-testid={`admin-credit-package-edit-${pkg.id}`}
                              onClick={() => openEditPackageDialog(pkg)}
                              className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              data-testid={`admin-credit-package-delete-${pkg.id}`}
                              onClick={() => handlePackageDelete(pkg)}
                              className="h-8 w-8 text-rose-400 hover:bg-rose-500/20"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {packageList.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                          暂无积分套餐，点击上方按钮创建
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Membership Plans Tab */}
          <TabsContent value="membership-plans" className="space-y-4">
            <div
              className="rounded-lg border p-4"
              style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
            >
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                会员价格（USD）、上下架和 Stripe Price ID 在本页维护；历史保留、导出权限和批量导出策略在
                <a href="/admin/settings" className="ml-1 underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>
                  系统设置 / 会员权限
                </a>
                中统一配置。本页解决“卖什么、卖多少钱、是否上架”，设置页解决“买完后拥有哪些历史保留与导出权限”。
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                onClick={openCreatePlanDialog}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                <Plus className="h-4 w-4 mr-2" />
                创建会员等级
              </Button>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-amber-500/20">
                      <Crown className="h-6 w-6 text-amber-400" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总等级数</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {planList.length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-emerald-500/20">
                      <Check className="h-6 w-6 text-emerald-400" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已启用</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {activePlanCount}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <CardContent className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-xl bg-rose-500/20">
                      <X className="h-6 w-6 text-rose-400" />
                    </div>
                    <div>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已禁用</p>
                      <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                        {planList.length - activePlanCount}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Membership Plans Table */}
            <Card data-testid="admin-packages-membership-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                <Table className="min-w-[1080px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>会员等级</TableHead>
                      <TableHead>月付价格 (USD)</TableHead>
                      <TableHead>年付价格 (USD)</TableHead>
                      <TableHead>Stripe</TableHead>
                      <TableHead>月积分</TableHead>
                      <TableHead>年积分</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="w-[120px]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {planList.map((plan: MembershipPlan) => {
                      const levelStyle = levelColors[plan.level] || levelColors.pro;
                      return (
                        <TableRow key={plan.id} data-testid={`admin-membership-plan-row-${plan.id}`}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <div
                                className={`p-2 rounded-lg ${levelStyle.bg}`}
                              >
                                {plan.level === 'gold' ? (
                                  <Crown className={`h-4 w-4 ${levelStyle.text}`} />
                                ) : plan.level === 'pro' ? (
                                  <Star className={`h-4 w-4 ${levelStyle.text}`} />
                                ) : (
                                  <Package className={`h-4 w-4 ${levelStyle.text}`} />
                                )}
                              </div>
                              <div>
                                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                  {plan.name}
                                </span>
                                <Badge className={`ml-2 ${levelStyle.bg} ${levelStyle.text}`}>
                                  {levelStyle.label}
                                </Badge>
                              </div>
                            </div>
                          </TableCell>
                          <TableCell>
                            <span style={{ color: 'var(--text-primary)' }}>
                              {formatUsdFromCents(plan.monthly_price)}/月
                            </span>
                          </TableCell>
                          <TableCell>
                            <span style={{ color: 'var(--text-primary)' }}>
                              {formatUsdFromCents(plan.yearly_price)}/年
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-1">
                              <Badge className={plan.stripe_monthly_price_id ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}>
                                月付 {plan.stripe_monthly_price_id ? '已配置' : '未配置'}
                              </Badge>
                              <Badge className={plan.stripe_yearly_price_id ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'}>
                                年付 {plan.stripe_yearly_price_id ? '已配置' : '未配置'}
                              </Badge>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Coins className="h-4 w-4 text-amber-400" />
                              <span style={{ color: 'var(--text-primary)' }}>
                                {plan.monthly_credits.toLocaleString()}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Coins className="h-4 w-4 text-amber-400" />
                              <span style={{ color: 'var(--text-primary)' }}>
                                {plan.yearly_credits.toLocaleString()}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge
                              data-testid={`admin-membership-plan-toggle-${plan.id}`}
                              className={plan.is_active === 'true'
                                ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                                : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                              }
                              onClick={() => handlePlanToggleActive(plan)}
                            >
                              {plan.is_active === 'true' ? (
                                <>
                                  <Check className="h-3 w-3 mr-1" />
                                  已启用
                                </>
                              ) : (
                                <>
                                  <X className="h-3 w-3 mr-1" />
                                  已禁用
                                </>
                              )}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`admin-membership-plan-edit-${plan.id}`}
                                onClick={() => openEditPlanDialog(plan)}
                                className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`admin-membership-plan-delete-${plan.id}`}
                                onClick={() => handlePlanDelete(plan)}
                                className="h-8 w-8 text-rose-400 hover:bg-rose-500/20"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {planList.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                          暂无会员等级，点击上方按钮创建
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Credit Package Create/Edit Dialog */}
        <Dialog open={packageDialogOpen} onOpenChange={setPackageDialogOpen}>
          <DialogContent
            className="max-w-lg max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {editingPackage ? '编辑积分包' : '创建积分包'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>套餐名称</Label>
                <Input
                  data-testid="credit-package-name-input"
                  value={packageFormData.name}
                  onChange={(e) => setPackageFormData({ ...packageFormData, name: e.target.value })}
                  placeholder="如：入门套餐"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>价格 (USD)</Label>
                  <Input
                    data-testid="credit-package-price-input"
                    type="number"
                    step="0.01"
                    value={packageFormData.price}
                    onChange={(e) => setPackageFormData({ ...packageFormData, price: e.target.value })}
                    placeholder="如：9.9"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>积分数量</Label>
                  <Input
                    data-testid="credit-package-credits-input"
                    type="number"
                    value={packageFormData.creditsAmount}
                    onChange={(e) => setPackageFormData({ ...packageFormData, creditsAmount: e.target.value })}
                    placeholder="如：1000"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>
                    <div className="flex items-center gap-2">
                      <Gift className="h-4 w-4 text-pink-400" />
                      赠送积分
                    </div>
                  </Label>
                  <Input
                    data-testid="credit-package-bonus-input"
                    type="number"
                    min="0"
                    value={packageFormData.bonusCredits}
                    onChange={(e) => setPackageFormData({ ...packageFormData, bonusCredits: e.target.value })}
                    placeholder="如：100"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    购买时额外赠送的积分
                  </p>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>
                    <div className="flex items-center gap-2">
                      <ArrowUpDown className="h-4 w-4" />
                      排序顺序
                    </div>
                  </Label>
                  <Input
                    type="number"
                    min="0"
                    value={packageFormData.sortOrder}
                    onChange={(e) => setPackageFormData({ ...packageFormData, sortOrder: e.target.value })}
                    placeholder="如：0"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    数字越小排序越靠前
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>Stripe Price ID</Label>
                <Input
                  value={packageFormData.stripePriceId}
                  onChange={(e) => setPackageFormData({ ...packageFormData, stripePriceId: e.target.value })}
                  placeholder="price_xxx"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  用于真实 Checkout 的一次性支付 Price ID
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>热门标识</Label>
                  <Select
                    value={packageFormData.isPopular}
                    onValueChange={(value) => setPackageFormData({ ...packageFormData, isPopular: value })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="false">
                        <span className="flex items-center gap-2">
                          <X className="h-4 w-4" />
                          普通
                        </span>
                      </SelectItem>
                      <SelectItem value="true">
                        <span className="flex items-center gap-2">
                          <Flame className="h-4 w-4 text-orange-400" />
                          热门推荐
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>上架状态</Label>
                  <Select
                    value={packageFormData.active}
                    onValueChange={(value) => setPackageFormData({ ...packageFormData, active: value })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="true">
                        <span className="flex items-center gap-2">
                          <Check className="h-4 w-4 text-emerald-400" />
                          已上架
                        </span>
                      </SelectItem>
                      <SelectItem value="false">
                        <span className="flex items-center gap-2">
                          <X className="h-4 w-4 text-rose-400" />
                          已下架
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={closePackageDialog}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                data-testid="credit-package-save"
                onClick={handlePackageSubmit}
                disabled={!packageFormData.name || !packageFormData.price || !packageFormData.creditsAmount || createPackage.isPending || updatePackage.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {createPackage.isPending || updatePackage.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Membership Plan Create/Edit Dialog */}
        <Dialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
          <DialogContent
            className="max-w-lg max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {editingPlan ? '编辑会员等级' : '创建会员等级'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>等级名称</Label>
                  <Input
                    data-testid="membership-plan-name-input"
                    value={planFormData.name}
                    onChange={(e) => setPlanFormData({ ...planFormData, name: e.target.value })}
                    placeholder="如：专业版"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>等级类型</Label>
                  <Select
                    value={planFormData.level}
                    onValueChange={(value: 'free' | 'pro' | 'gold') => setPlanFormData({ ...planFormData, level: value })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="free">免费版</SelectItem>
                      <SelectItem value="pro">Pro 专业版</SelectItem>
                      <SelectItem value="gold">Gold 黄金版</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>月付价格 (USD)</Label>
                  <Input
                    data-testid="membership-plan-monthly-price-input"
                    type="number"
                    step="0.01"
                    value={planFormData.monthlyPrice}
                    onChange={(e) => setPlanFormData({ ...planFormData, monthlyPrice: e.target.value })}
                    placeholder="如：9.9"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>年付价格 (USD)</Label>
                  <Input
                    data-testid="membership-plan-yearly-price-input"
                    type="number"
                    step="0.01"
                    value={planFormData.yearlyPrice}
                    onChange={(e) => setPlanFormData({ ...planFormData, yearlyPrice: e.target.value })}
                    placeholder="如：99"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>Stripe 月付 Price ID</Label>
                  <Input
                    value={planFormData.stripeMonthlyPriceId}
                    onChange={(e) => setPlanFormData({ ...planFormData, stripeMonthlyPriceId: e.target.value })}
                    placeholder="price_xxx"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>Stripe 年付 Price ID</Label>
                  <Input
                    value={planFormData.stripeYearlyPriceId}
                    onChange={(e) => setPlanFormData({ ...planFormData, stripeYearlyPriceId: e.target.value })}
                    placeholder="price_xxx"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>月积分额度</Label>
                  <Input
                    data-testid="membership-plan-monthly-credits-input"
                    type="number"
                    value={planFormData.monthlyCredits}
                    onChange={(e) => setPlanFormData({ ...planFormData, monthlyCredits: e.target.value })}
                    placeholder="如：1500"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>年积分额度</Label>
                  <Input
                    data-testid="membership-plan-yearly-credits-input"
                    type="number"
                    value={planFormData.yearlyCredits}
                    onChange={(e) => setPlanFormData({ ...planFormData, yearlyCredits: e.target.value })}
                    placeholder="如：20000"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>月奖励积分</Label>
                  <Input
                    type="number"
                    value={planFormData.monthlyBonusCredits}
                    onChange={(e) => setPlanFormData({ ...planFormData, monthlyBonusCredits: e.target.value })}
                    placeholder="如：0"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>加油包折扣 (%)</Label>
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={planFormData.packageDiscount}
                    onChange={(e) => setPlanFormData({ ...planFormData, packageDiscount: e.target.value })}
                    placeholder="如：100 (无折扣)"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>上下文消息数</Label>
                  <Input
                    type="number"
                    min="5"
                    max="100"
                    value={planFormData.maxContextMessages}
                    onChange={(e) => setPlanFormData({ ...planFormData, maxContextMessages: e.target.value })}
                    placeholder="如：20"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    AI 对话时携带的历史消息数量限制
                  </p>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>排序顺序</Label>
                  <Input
                    type="number"
                    value={planFormData.sortOrder}
                    onChange={(e) => setPlanFormData({ ...planFormData, sortOrder: e.target.value })}
                    placeholder="如：0"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>会员权益 (每行一个)</Label>
                <textarea
                  value={planFormData.features}
                  onChange={(e) => setPlanFormData({ ...planFormData, features: e.target.value })}
                  placeholder="如：&#10;无限对话&#10;优先客服&#10;专属模型"
                  rows={4}
                  className="w-full px-3 py-2 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={closePlanDialog}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                data-testid="membership-plan-save"
                onClick={handlePlanSubmit}
                disabled={!planFormData.name || createMembershipPlan.isPending || updateMembershipPlan.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {createMembershipPlan.isPending || updateMembershipPlan.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </div>
  );
}
