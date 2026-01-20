'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Package, Plus, Pencil, Trash2, Check, X,
  DollarSign, Coins
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import AdminSidebar from '@/components/admin/AdminSidebar';

interface CreditPackage {
  id: string;
  name: string;
  price: number;
  credits_amount: number;
  active: string;
  created_at: string;
}

export default function AdminPackagesPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPackage, setEditingPackage] = useState<CreditPackage | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    price: '',
    creditsAmount: '',
  });

  const { data: packages, isLoading, error, refetch } = trpc.admin.getAllPackages.useQuery();

  const createPackage = trpc.admin.createPackage.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const updatePackage = trpc.admin.updatePackage.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const deletePackage = trpc.admin.deletePackage.useMutation({
    onSuccess: () => {
      refetch();
    }
  });

  const openCreateDialog = () => {
    setEditingPackage(null);
    setFormData({ name: '', price: '', creditsAmount: '' });
    setDialogOpen(true);
  };

  const openEditDialog = (pkg: CreditPackage) => {
    setEditingPackage(pkg);
    setFormData({
      name: pkg.name,
      price: (pkg.price / 100).toString(),
      creditsAmount: pkg.credits_amount.toString(),
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingPackage(null);
    setFormData({ name: '', price: '', creditsAmount: '' });
  };

  const handleSubmit = () => {
    const priceInCents = Math.round(parseFloat(formData.price) * 100);
    const creditsAmount = parseInt(formData.creditsAmount);

    if (editingPackage) {
      updatePackage.mutate({
        id: editingPackage.id,
        name: formData.name,
        price: priceInCents,
        creditsAmount,
      });
    } else {
      createPackage.mutate({
        name: formData.name,
        price: priceInCents,
        creditsAmount,
      });
    }
  };

  const handleToggleActive = (pkg: CreditPackage) => {
    updatePackage.mutate({
      id: pkg.id,
      active: pkg.active === 'true' ? 'false' : 'true',
    });
  };

  const handleDelete = (pkg: CreditPackage) => {
    if (confirm(`确定要删除 "${pkg.name}" 吗？`)) {
      deletePackage.mutate({ id: pkg.id });
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
        <AdminSidebar />
        <div className="flex-1 p-8">
          <Card
            className="max-w-md mx-auto mt-20"
            style={{ background: 'var(--error-bg)', border: '1px solid var(--error)' }}
          >
            <CardContent className="pt-6">
              <p style={{ color: 'var(--error)' }}>
                {error.message.includes('Admin role required')
                  ? '访问被拒绝：您需要管理员权限才能查看此页面。'
                  : `错误: ${error.message}`}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const packageList = packages ?? [];
  const activeCount = packageList.filter((p: CreditPackage) => p.active === 'true').length;

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              积分包管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理积分充值套餐
            </p>
          </div>
          <Button
            onClick={openCreateDialog}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            创建套餐
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
                    {activeCount}
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
                    {packageList.length - activeCount}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Packages Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>套餐名称</TableHead>
                  <TableHead>价格</TableHead>
                  <TableHead>积分数量</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[120px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packageList.map((pkg: CreditPackage) => (
                  <TableRow key={pkg.id}>
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
                          ¥{(pkg.price / 100).toFixed(2)}
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
                      <Badge
                        className={pkg.active === 'true'
                          ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                          : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                        }
                        onClick={() => handleToggleActive(pkg)}
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
                    <TableCell style={{ color: 'var(--text-tertiary)' }}>
                      {new Date(pkg.created_at).toLocaleDateString('zh-CN')}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEditDialog(pkg)}
                          className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(pkg)}
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
                    <TableCell colSpan={6} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无积分套餐，点击上方按钮创建
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Create/Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="max-w-md"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {editingPackage ? '编辑套餐' : '创建套餐'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>套餐名称</Label>
                <Input
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="如：入门套餐"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>价格 (元)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={formData.price}
                  onChange={(e) => setFormData({ ...formData, price: e.target.value })}
                  placeholder="如：9.9"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>积分数量</Label>
                <Input
                  type="number"
                  value={formData.creditsAmount}
                  onChange={(e) => setFormData({ ...formData, creditsAmount: e.target.value })}
                  placeholder="如：1000"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={closeDialog}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={!formData.name || !formData.price || !formData.creditsAmount || createPackage.isPending || updatePackage.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {createPackage.isPending || updatePackage.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
