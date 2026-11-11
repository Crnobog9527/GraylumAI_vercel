/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import {
  Package, Plus, Pencil, Trash2, Check, X,
  DollarSign, Coins, Flame, Gift, ArrowUpDown
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
import type { CreditPackage } from './packagesShared';
import type { CreditPackageAdmin } from './useCreditPackageAdmin';

// 积分加油包标签页：创建按钮、统计卡片、列表。从 page.tsx 原样搬出。
export function CreditPackagesTab({ packageList, activePackageCount, admin }: {
  packageList: CreditPackage[];
  activePackageCount: number;
  admin: CreditPackageAdmin;
}) {
  const { openCreatePackageDialog, openEditPackageDialog, handlePackageToggleActive, handlePackageDelete } = admin;

  return (
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
  );
}
