'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  CreditCard, TrendingUp, TrendingDown, RefreshCw,
  ArrowUpCircle, ArrowDownCircle, ShoppingCart, RotateCcw,
  User
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AdminSidebar from '@/components/admin/AdminSidebar';

type TransactionType = 'deduction' | 'addition' | 'purchase' | 'refund';

interface Transaction {
  id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  description: string | null;
  created_at: string;
  profiles: {
    id: string;
    email: string;
    nickname: string | null;
  } | null;
}

const typeConfig: Record<TransactionType, { label: string; color: string; icon: React.ElementType }> = {
  addition: { label: '增加', color: 'bg-emerald-500/20 text-emerald-400', icon: ArrowUpCircle },
  deduction: { label: '扣除', color: 'bg-rose-500/20 text-rose-400', icon: ArrowDownCircle },
  purchase: { label: '购买', color: 'bg-blue-500/20 text-blue-400', icon: ShoppingCart },
  refund: { label: '退款', color: 'bg-amber-500/20 text-amber-400', icon: RotateCcw },
};

export default function AdminTransactionsPage() {
  const [typeFilter, setTypeFilter] = useState<TransactionType | 'all'>('all');

  const { data, isLoading, error, refetch } = trpc.admin.getAllTransactions.useQuery({
    type: typeFilter === 'all' ? undefined : typeFilter,
    limit: 50,
  });

  const transactions = data?.transactions ?? [];
  const stats = data?.stats ?? {
    totalAdditions: 0,
    totalDeductions: 0,
    totalPurchases: 0,
    totalRefunds: 0,
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

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              交易记录
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              查看所有用户的积分交易记录
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => refetch()}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            刷新
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-emerald-500/20">
                  <TrendingUp className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总增加</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    +{stats.totalAdditions.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-rose-500/20">
                  <TrendingDown className="h-6 w-6 text-rose-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总扣除</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    -{stats.totalDeductions.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-blue-500/20">
                  <ShoppingCart className="h-6 w-6 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总购买</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    +{stats.totalPurchases.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-amber-500/20">
                  <RotateCcw className="h-6 w-6 text-amber-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总退款</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    +{stats.totalRefunds.toLocaleString()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filter Tabs */}
        <Tabs value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)} className="mb-6">
          <TabsList className="bg-[var(--bg-tertiary)]">
            <TabsTrigger value="all" className="data-[state=active]:bg-[var(--bg-secondary)]">
              全部
            </TabsTrigger>
            <TabsTrigger value="addition" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <ArrowUpCircle className="h-4 w-4 mr-1 text-emerald-400" />
              增加
            </TabsTrigger>
            <TabsTrigger value="deduction" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <ArrowDownCircle className="h-4 w-4 mr-1 text-rose-400" />
              扣除
            </TabsTrigger>
            <TabsTrigger value="purchase" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <ShoppingCart className="h-4 w-4 mr-1 text-blue-400" />
              购买
            </TabsTrigger>
            <TabsTrigger value="refund" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <RotateCcw className="h-4 w-4 mr-1 text-amber-400" />
              退款
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Transactions Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>描述</TableHead>
                  <TableHead>时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((transaction: Transaction) => {
                  const config = typeConfig[transaction.type];
                  const TypeIcon = config.icon;
                  const isPositive = transaction.amount > 0;
                  return (
                    <TableRow key={transaction.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="p-2 rounded-lg"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <User className="h-4 w-4 text-[var(--text-tertiary)]" />
                          </div>
                          <div>
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {transaction.profiles?.nickname || '未知用户'}
                            </p>
                            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                              {transaction.profiles?.email || transaction.user_id}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={config.color}>
                          <TypeIcon className="h-3 w-3 mr-1" />
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span
                          className="font-semibold"
                          style={{ color: isPositive ? 'var(--success)' : 'var(--error)' }}
                        >
                          {isPositive ? '+' : ''}{transaction.amount.toLocaleString()}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm truncate max-w-[200px] block" style={{ color: 'var(--text-tertiary)' }}>
                          {transaction.description || '-'}
                        </span>
                      </TableCell>
                      <TableCell style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(transaction.created_at).toLocaleString('zh-CN')}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {transactions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无交易记录
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
