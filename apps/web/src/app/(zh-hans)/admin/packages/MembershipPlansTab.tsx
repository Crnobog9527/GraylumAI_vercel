/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import {
  Package, Plus, Pencil, Trash2, Check, X,
  Coins, Crown, Star
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatUsdFromCents } from '@/lib/currency';
import { levelColors, type MembershipPlan } from './packagesShared';
import type { MembershipPlanAdmin } from './useMembershipPlanAdmin';

// 会员等级标签页：说明、创建按钮、统计卡片、列表。从 page.tsx 原样搬出。
export function MembershipPlansTab({ planList, activePlanCount, admin }: {
  planList: MembershipPlan[];
  activePlanCount: number;
  admin: MembershipPlanAdmin;
}) {
  const { openCreatePlanDialog, openEditPlanDialog, handlePlanToggleActive, handlePlanDelete } = admin;

  return (
    <TabsContent value="membership-plans" className="space-y-4">
      <div
        className="rounded-lg border p-4"
        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
      >
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          会员价格（USD）、上下架和 Stripe Price ID 在本页维护；导出权限和批量导出策略在
          <a href="/admin/settings" className="ml-1 underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>
            系统设置 / 会员权限
          </a>
          中统一配置。本页解决“卖什么、卖多少钱、是否上架”，设置页解决“买完后拥有哪些导出权限”。
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
  );
}
