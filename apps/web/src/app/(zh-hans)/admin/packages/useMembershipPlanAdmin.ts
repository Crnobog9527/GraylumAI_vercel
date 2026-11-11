/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { toast } from '@/components/ui/sonner';
import type { MembershipPlan } from './packagesShared';

// 会员等级：表单状态、保存和删除请求、各个操作。从 page.tsx 原样搬出。
export function useMembershipPlanAdmin(refreshPackagesDashboard: (fallback?: string) => void) {
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

  // Membership Plan Mutations
  const createMembershipPlan = trpc.admin.createMembershipPlan.useMutation({
    onSuccess: () => {
      closePlanDialog();
      refreshPackagesDashboard();
      toast.success('会员等级已创建');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '创建会员等级失败，请稍后重试'));
    }
  });

  const updateMembershipPlan = trpc.admin.updateMembershipPlan.useMutation({
    onSuccess: () => {
      closePlanDialog();
      refreshPackagesDashboard();
      toast.success('会员等级已保存');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '保存会员等级失败，请稍后重试'));
    }
  });

  const deleteMembershipPlan = trpc.admin.deleteMembershipPlan.useMutation({
    onSuccess: () => {
      refreshPackagesDashboard('会员等级已删除，但列表刷新失败，请手动刷新页面确认。');
      toast.success('会员等级已删除');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '删除会员等级失败，请稍后重试'));
    }
  });

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
    const name = planFormData.name.trim();
    const monthlyPrice = Math.round(Number(planFormData.monthlyPrice || '0') * 100);
    const yearlyPrice = Math.round(Number(planFormData.yearlyPrice || '0') * 100);
    const monthlyCredits = Math.trunc(Number(planFormData.monthlyCredits || '0'));
    const yearlyCredits = Math.trunc(Number(planFormData.yearlyCredits || '0'));
    const monthlyBonusCredits = Math.trunc(Number(planFormData.monthlyBonusCredits || '0'));
    const packageDiscount = Math.trunc(Number(planFormData.packageDiscount || '100'));
    const maxContextMessages = Math.trunc(Number(planFormData.maxContextMessages || '20'));
    const sortOrder = Math.trunc(Number(planFormData.sortOrder || '0'));
    const stripeMonthlyPriceId = planFormData.stripeMonthlyPriceId.trim();
    const stripeYearlyPriceId = planFormData.stripeYearlyPriceId.trim();

    if (!name) {
      toast.error('请填写等级名称');
      return;
    }

    if (!Number.isFinite(monthlyPrice) || monthlyPrice < 0 || !Number.isFinite(yearlyPrice) || yearlyPrice < 0) {
      toast.error('会员价格不能小于 0');
      return;
    }

    if (!Number.isFinite(monthlyCredits) || monthlyCredits < 0 || !Number.isFinite(yearlyCredits) || yearlyCredits < 0) {
      toast.error('会员积分额度不能小于 0');
      return;
    }

    if (!Number.isFinite(monthlyBonusCredits) || monthlyBonusCredits < 0) {
      toast.error('月奖励积分不能小于 0');
      return;
    }

    if (!Number.isFinite(packageDiscount) || packageDiscount < 0 || packageDiscount > 100) {
      toast.error('加油包折扣必须在 0 到 100 之间');
      return;
    }

    if (!Number.isFinite(maxContextMessages) || maxContextMessages < 5 || maxContextMessages > 100) {
      toast.error('上下文消息数必须在 5 到 100 之间');
      return;
    }

    if (!Number.isFinite(sortOrder) || sortOrder < 0) {
      toast.error('排序顺序不能小于 0');
      return;
    }

    const data = {
      name,
      level: planFormData.level,
      monthlyCredits,
      yearlyCredits,
      monthlyBonusCredits,
      packageDiscount,
      maxContextMessages,
      features: planFormData.features.split('\n').filter(f => f.trim()),
      sortOrder,
    };

    if (editingPlan) {
      updateMembershipPlan.mutate({
        id: editingPlan.id,
        ...data, // unchanged Stripe price ids are not resubmitted: the server re-verifies them and could fail a rename
        ...(stripeMonthlyPriceId !== (editingPlan.stripe_monthly_price_id ?? '') && { stripeMonthlyPriceId: stripeMonthlyPriceId || null }),
        ...(stripeYearlyPriceId !== (editingPlan.stripe_yearly_price_id ?? '') && { stripeYearlyPriceId: stripeYearlyPriceId || null }),
      });
    } else {
      createMembershipPlan.mutate({
        ...data,
        monthlyPrice, yearlyPrice,
        stripeMonthlyPriceId: stripeMonthlyPriceId || undefined,
        stripeYearlyPriceId: stripeYearlyPriceId || undefined,
      });
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

  return {
    planDialogOpen, setPlanDialogOpen, editingPlan, planFormData, setPlanFormData,
    // the dialog only reads whether a save is in flight (the full tRPC mutation type cannot be exported by name)
    createMembershipPlan: { isPending: createMembershipPlan.isPending },
    updateMembershipPlan: { isPending: updateMembershipPlan.isPending },
    openCreatePlanDialog, openEditPlanDialog, closePlanDialog,
    handlePlanSubmit, handlePlanToggleActive, handlePlanDelete,
  };
}

export type MembershipPlanAdmin = ReturnType<typeof useMembershipPlanAdmin>;
