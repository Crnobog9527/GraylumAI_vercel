/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

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
import type { MembershipPlanAdmin } from './useMembershipPlanAdmin';

// 会员等级的创建 / 编辑弹窗。从 page.tsx 原样搬出。
export function MembershipPlanDialog({ admin }: { admin: MembershipPlanAdmin }) {
  const {
    planDialogOpen, setPlanDialogOpen, editingPlan, planFormData, setPlanFormData,
    createMembershipPlan, updateMembershipPlan, closePlanDialog, handlePlanSubmit,
  } = admin;

  return (
    <Dialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <DialogHeader>
          <DialogTitle style={{ color: 'var(--text-primary)' }}>
            {editingPlan ? '编辑会员等级' : '创建会员等级'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            设置会员等级的价格、积分权益、Stripe 价格和展示顺序。
          </DialogDescription>
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
              <Select disabled={Boolean(editingPlan)}
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
              {editingPlan && <p className="text-sm text-muted-foreground">修改等级需同时设置会员权益，暂不支持</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>月付价格 (USD){editingPlan ? '（只读，改价走迁移）' : ''}</Label>
              <Input
                data-testid="membership-plan-monthly-price-input"
                type="number"
                step="0.01"
                value={planFormData.monthlyPrice} disabled={Boolean(editingPlan)}
                onChange={(e) => setPlanFormData({ ...planFormData, monthlyPrice: e.target.value })}
                placeholder="如：9.9"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>年付价格 (USD){editingPlan ? '（只读，改价走迁移）' : ''}</Label>
              <Input
                data-testid="membership-plan-yearly-price-input"
                type="number"
                step="0.01"
                value={planFormData.yearlyPrice} disabled={Boolean(editingPlan)}
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
              className={'w-full px-3 py-2 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-primary)]'
                + ' text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]'}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={closePlanDialog}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            取消
          </Button>
          <Button
            type="button"
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
  );
}
