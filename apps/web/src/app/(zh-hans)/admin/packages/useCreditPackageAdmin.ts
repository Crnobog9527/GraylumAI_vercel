/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage } from '@/lib/safe-error-message';
import { toast } from '@/components/ui/sonner';
import type { CreditPackage } from './packagesShared';

// 积分加油包：表单状态、保存和删除请求、各个操作。从 page.tsx 原样搬出。
export function useCreditPackageAdmin(refreshPackagesDashboard: (fallback?: string) => void) {
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

  // Credit Package Mutations
  const createPackage = trpc.admin.createPackage.useMutation({
    onSuccess: () => {
      closePackageDialog();
      refreshPackagesDashboard();
      toast.success('积分包已创建');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '创建积分包失败，请稍后重试'));
    }
  });

  const updatePackage = trpc.admin.updatePackage.useMutation({
    onSuccess: () => {
      closePackageDialog();
      refreshPackagesDashboard();
      toast.success('积分包已保存');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '保存积分包失败，请稍后重试'));
    }
  });

  const deletePackage = trpc.admin.deletePackage.useMutation({
    onSuccess: () => {
      refreshPackagesDashboard('积分包已删除，但列表刷新失败，请手动刷新页面确认。');
      toast.success('积分包已删除');
    },
    onError: (error) => {
      toast.error(getSafeErrorMessage(error, '删除积分包失败，请稍后重试'));
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
    const name = packageFormData.name.trim();
    const priceInCents = Math.round(Number(packageFormData.price) * 100);
    const creditsAmount = Math.trunc(Number(packageFormData.creditsAmount));
    const bonusCredits = Math.trunc(Number(packageFormData.bonusCredits || '0'));
    const sortOrder = Math.trunc(Number(packageFormData.sortOrder || '0'));
    const stripePriceId = packageFormData.stripePriceId.trim();

    if (!name) {
      toast.error('请填写套餐名称');
      return;
    }

    if (!Number.isFinite(priceInCents) || priceInCents <= 0) {
      toast.error('请填写大于 0 的价格');
      return;
    }

    if (!Number.isFinite(creditsAmount) || creditsAmount <= 0) {
      toast.error('请填写大于 0 的积分数量');
      return;
    }

    if (!Number.isFinite(bonusCredits) || bonusCredits < 0) {
      toast.error('赠送积分不能小于 0');
      return;
    }

    if (!Number.isFinite(sortOrder) || sortOrder < 0) {
      toast.error('排序顺序不能小于 0');
      return;
    }

    if (editingPackage) {
      updatePackage.mutate({
        id: editingPackage.id,
        name,
        price: priceInCents,
        creditsAmount,
        bonusCredits,
        stripePriceId: stripePriceId || null,
        sortOrder,
        isPopular: packageFormData.isPopular as 'true' | 'false',
        active: packageFormData.active as 'true' | 'false',
      });
    } else {
      createPackage.mutate({
        name,
        price: priceInCents,
        creditsAmount,
        bonusCredits,
        stripePriceId: stripePriceId || undefined,
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

  return {
    packageDialogOpen, setPackageDialogOpen, editingPackage, packageFormData, setPackageFormData,
    // the dialog only reads whether a save is in flight (the full tRPC mutation type cannot be exported by name)
    createPackage: { isPending: createPackage.isPending }, updatePackage: { isPending: updatePackage.isPending },
    openCreatePackageDialog, openEditPackageDialog, closePackageDialog,
    handlePackageSubmit, handlePackageToggleActive, handlePackageDelete,
  };
}

export type CreditPackageAdmin = ReturnType<typeof useCreditPackageAdmin>;
