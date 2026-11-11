/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Check, X, Flame, Gift, ArrowUpDown } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { CreditPackageAdmin } from './useCreditPackageAdmin';

// 积分包的创建 / 编辑弹窗。从 page.tsx 原样搬出。
export function CreditPackageDialog({ admin }: { admin: CreditPackageAdmin }) {
  const {
    packageDialogOpen, setPackageDialogOpen, editingPackage, packageFormData, setPackageFormData,
    createPackage, updatePackage, closePackageDialog, handlePackageSubmit,
  } = admin;

  return (
    <Dialog open={packageDialogOpen} onOpenChange={setPackageDialogOpen}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>
            {editingPackage ? '编辑积分包' : '创建积分包'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            设置积分包的价格、积分数量、赠送额度和上架状态。
          </DialogDescription>
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
            type="button"
            variant="outline"
            onClick={closePackageDialog}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            取消
          </Button>
          <Button
            type="button"
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
  );
}
