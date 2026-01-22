'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Activity, PlayCircle, RefreshCw, CheckCircle, XCircle,
  AlertTriangle, Clock, Zap, Shield, DollarSign, Brain,
  ChevronDown, ChevronRight, History, Trash2, Server,
  Gauge, Database, TrendingUp
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  TabsContent,
} from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type DiagnosticStatus = 'passed' | 'failed' | 'warning' | 'skipped' | 'error';
type DiagnosticCategory = 'ai' | 'billing' | 'security' | 'performance' | 'data';

interface TestResult {
  testId: string;
  testName: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
  latencyMs: number;
}

const statusConfig: Record<DiagnosticStatus, { label: string; color: string; bgColor: string; icon: React.ElementType }> = {
  passed: { label: '通过', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20', icon: CheckCircle },
  failed: { label: '失败', color: 'text-red-400', bgColor: 'bg-red-500/20', icon: XCircle },
  warning: { label: '警告', color: 'text-amber-400', bgColor: 'bg-amber-500/20', icon: AlertTriangle },
  skipped: { label: '跳过', color: 'text-gray-400', bgColor: 'bg-gray-500/20', icon: ChevronRight },
  error: { label: '错误', color: 'text-red-400', bgColor: 'bg-red-500/20', icon: XCircle },
};

const categoryConfig: Record<DiagnosticCategory, { label: string; icon: React.ElementType; color: string }> = {
  ai: { label: 'AI 功能', icon: Brain, color: 'text-purple-400' },
  billing: { label: '计费功能', icon: DollarSign, color: 'text-emerald-400' },
  security: { label: '安全功能', icon: Shield, color: 'text-blue-400' },
  performance: { label: '性能', icon: Zap, color: 'text-amber-400' },
  data: { label: '数据', icon: Database, color: 'text-cyan-400' },
};

function StatusBadge({ status }: { status: DiagnosticStatus }) {
  const config = statusConfig[status];
  const Icon = config.icon;

  return (
    <Badge className={`${config.bgColor} ${config.color} gap-1`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

function CategoryBadge({ category }: { category: DiagnosticCategory }) {
  const config = categoryConfig[category];
  const Icon = config.icon;

  return (
    <div className={`flex items-center gap-1.5 ${config.color}`}>
      <Icon className="h-4 w-4" />
      <span className="text-sm">{config.label}</span>
    </div>
  );
}

function TestResultRow({ result, onRerun }: { result: TestResult; onRerun: (testId: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <TableRow className="hover:bg-[var(--bg-tertiary)]">
        <TableCell>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="p-0 h-auto">
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-[var(--text-tertiary)]" />
              ) : (
                <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
              )}
            </Button>
          </CollapsibleTrigger>
        </TableCell>
        <TableCell>
          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
            {result.testName}
          </span>
        </TableCell>
        <TableCell>
          <CategoryBadge category={result.category} />
        </TableCell>
        <TableCell>
          <StatusBadge status={result.status} />
        </TableCell>
        <TableCell>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {result.message.length > 50 ? `${result.message.substring(0, 50)}...` : result.message}
          </span>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-[var(--text-tertiary)]" />
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              {result.latencyMs}ms
            </span>
          </div>
        </TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onRerun(result.testId)}
            className="h-8 w-8 p-0"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </TableCell>
      </TableRow>
      <CollapsibleContent asChild>
        <TableRow>
          <TableCell colSpan={7} className="p-0">
            <div className="p-4 bg-[var(--bg-tertiary)] border-t border-[var(--border-primary)]">
              <div className="space-y-2">
                <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                  完整消息:
                </p>
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {result.message}
                </p>
                {result.details && Object.keys(result.details).length > 0 && (
                  <>
                    <p className="text-sm font-medium mt-4" style={{ color: 'var(--text-secondary)' }}>
                      详细信息:
                    </p>
                    <pre className="text-xs p-3 rounded-lg bg-[var(--bg-secondary)] overflow-auto max-h-60" style={{ color: 'var(--text-tertiary)' }}>
                      {JSON.stringify(result.details, null, 2)}
                    </pre>
                  </>
                )}
              </div>
            </div>
          </TableCell>
        </TableRow>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function AdminDiagnosticsPage() {
  const [isRunning, setIsRunning] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<DiagnosticCategory | 'all'>('all');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Queries
  const { data: latestResults, refetch: refetchLatest, error: latestError } = trpc.diagnostics.getLatestResults.useQuery();
  const { data: summaryStats, refetch: refetchSummary, error: summaryError } = trpc.diagnostics.getSummaryStats.useQuery();
  const { data: healthCheck, refetch: refetchHealth, error: healthError } = trpc.diagnostics.healthCheck.useQuery();
  const { data: recentRuns } = trpc.diagnostics.getRecentRuns.useQuery();
  const { data: testDefinitions } = trpc.diagnostics.getTestDefinitions.useQuery();

  // Log any query errors
  if (latestError) console.error('latestResults error:', latestError);
  if (summaryError) console.error('summaryStats error:', summaryError);
  if (healthError) console.error('healthCheck error:', healthError);

  // Mutations
  const runAllMutation = trpc.diagnostics.runAllTests.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
      refetchHealth();
      setIsRunning(false);
      setErrorMessage(null);
    },
    onError: (error) => {
      setIsRunning(false);
      setErrorMessage(error.message || '运行测试失败');
      console.error('runAllTests error:', error);
    },
  });

  const runCategoryMutation = trpc.diagnostics.runCategoryTests.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
      setIsRunning(false);
      setErrorMessage(null);
    },
    onError: (error) => {
      setIsRunning(false);
      setErrorMessage(error.message || '运行测试失败');
      console.error('runCategoryTests error:', error);
    },
  });

  const runSingleMutation = trpc.diagnostics.runSingleTest.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error.message || '运行测试失败');
      console.error('runSingleTest error:', error);
    },
  });

  const cleanupMutation = trpc.diagnostics.cleanupOldResults.useMutation({
    onSuccess: () => {
      refetchLatest();
    },
  });

  const handleRunAll = () => {
    console.log('handleRunAll called');
    console.log('mutation state:', { isPending: runAllMutation.isPending, isError: runAllMutation.isError });
    setIsRunning(true);
    runAllMutation.mutate({}, {
      onSettled: () => {
        console.log('mutation settled');
      }
    });
  };

  const handleRunCategory = (category: DiagnosticCategory) => {
    setIsRunning(true);
    runCategoryMutation.mutate({ category });
  };

  const handleRunSingle = (testId: string) => {
    runSingleMutation.mutate({ testId });
  };

  const handleCleanup = () => {
    if (confirm('确定要清理 30 天前的诊断记录吗？')) {
      cleanupMutation.mutate({});
    }
  };

  // Filter results by category
  const filteredResults = selectedCategory === 'all'
    ? (latestResults ?? [])
    : (latestResults ?? []).filter(r => r.category === selectedCategory);

  // Calculate category stats
  const categoryStats = {
    ai: { total: 0, passed: 0 },
    billing: { total: 0, passed: 0 },
    security: { total: 0, passed: 0 },
  };

  (latestResults ?? []).forEach(r => {
    if (r.category in categoryStats) {
      categoryStats[r.category as keyof typeof categoryStats].total++;
      if (r.status === 'passed') {
        categoryStats[r.category as keyof typeof categoryStats].passed++;
      }
    }
  });

  // Health status
  const healthStatus = healthCheck?.status ?? 'healthy';
  const healthColor = healthStatus === 'healthy' ? 'text-emerald-400' : healthStatus === 'warning' ? 'text-amber-400' : 'text-red-400';
  const healthBgColor = healthStatus === 'healthy' ? 'bg-emerald-500/20' : healthStatus === 'warning' ? 'bg-amber-500/20' : 'bg-red-500/20';

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              系统诊断
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              一键测试所有关键功能，确保系统健康运行
            </p>
          </div>
          {/* Health Status Badge */}
          <Badge className={`${healthBgColor} ${healthColor} px-3 py-1 text-sm`}>
            <Server className="h-4 w-4 mr-1" />
            系统{healthStatus === 'healthy' ? '健康' : healthStatus === 'warning' ? '警告' : '异常'}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            onClick={handleCleanup}
            disabled={cleanupMutation.isPending}
            className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            清理旧记录
          </Button>
          <Button
            onClick={handleRunAll}
            disabled={isRunning}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
          >
            {isRunning ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                运行中...
              </>
            ) : (
              <>
                <PlayCircle className="h-4 w-4 mr-2" />
                运行所有测试
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/20 border border-red-500/30">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-red-400">测试运行失败</p>
              <p className="text-sm text-red-300 mt-1">{errorMessage}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setErrorMessage(null)}
              className="text-red-400 hover:text-red-300"
            >
              关闭
            </Button>
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>通过率</p>
                <p className="text-3xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {summaryStats?.pass_rate ?? 0}%
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {summaryStats?.passed_tests ?? 0}/{summaryStats?.total_tests ?? 0} 通过
                </p>
              </div>
              <div className={`p-3 rounded-xl ${(summaryStats?.pass_rate ?? 0) >= 80 ? 'bg-emerald-500/20' : 'bg-amber-500/20'}`}>
                <Gauge className={`h-6 w-6 ${(summaryStats?.pass_rate ?? 0) >= 80 ? 'text-emerald-400' : 'text-amber-400'}`} />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>AI 功能</p>
                <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {categoryStats.ai.passed}/{categoryStats.ai.total}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRunCategory('ai')}
                  disabled={isRunning}
                  className="text-xs p-0 h-auto mt-1 text-purple-400 hover:text-purple-300"
                >
                  运行测试
                </Button>
              </div>
              <div className="p-3 rounded-xl bg-purple-500/20">
                <Brain className="h-6 w-6 text-purple-400" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>计费功能</p>
                <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {categoryStats.billing.passed}/{categoryStats.billing.total}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRunCategory('billing')}
                  disabled={isRunning}
                  className="text-xs p-0 h-auto mt-1 text-emerald-400 hover:text-emerald-300"
                >
                  运行测试
                </Button>
              </div>
              <div className="p-3 rounded-xl bg-emerald-500/20">
                <DollarSign className="h-6 w-6 text-emerald-400" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>安全功能</p>
                <p className="text-2xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {categoryStats.security.passed}/{categoryStats.security.total}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRunCategory('security')}
                  disabled={isRunning}
                  className="text-xs p-0 h-auto mt-1 text-blue-400 hover:text-blue-300"
                >
                  运行测试
                </Button>
              </div>
              <div className="p-3 rounded-xl bg-blue-500/20">
                <Shield className="h-6 w-6 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="results" className="space-y-6">
        <TabsList className="bg-[var(--bg-tertiary)]">
          <TabsTrigger value="results" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Activity className="h-4 w-4 mr-2" />
            测试结果
          </TabsTrigger>
          <TabsTrigger value="health" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Server className="h-4 w-4 mr-2" />
            健康检查
          </TabsTrigger>
          <TabsTrigger value="history" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <History className="h-4 w-4 mr-2" />
            运行历史
          </TabsTrigger>
        </TabsList>

        {/* Results Tab */}
        <TabsContent value="results" className="space-y-6">
          {/* Category Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>筛选:</span>
            <Button
              variant={selectedCategory === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory('all')}
              className={selectedCategory === 'all' ? 'bg-[var(--color-primary)]' : ''}
            >
              全部
            </Button>
            {Object.entries(categoryConfig).map(([key, config]) => {
              const Icon = config.icon;
              return (
                <Button
                  key={key}
                  variant={selectedCategory === key ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSelectedCategory(key as DiagnosticCategory)}
                  className={selectedCategory === key ? 'bg-[var(--color-primary)]' : ''}
                >
                  <Icon className="h-4 w-4 mr-1" />
                  {config.label}
                </Button>
              );
            })}
          </div>

          {/* Results Table */}
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>测试名称</TableHead>
                    <TableHead>类别</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>消息</TableHead>
                    <TableHead>耗时</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredResults.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                        暂无测试结果，请运行诊断测试
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredResults.map((result) => (
                      <TestResultRow
                        key={result.testId}
                        result={result}
                        onRerun={handleRunSingle}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Health Check Tab */}
        <TabsContent value="health" className="space-y-6">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5" />
                  系统健康检查
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchHealth()}
                  className="border-[var(--border-primary)]"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  刷新
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {healthCheck?.checks && Object.entries(healthCheck.checks).map(([key, check]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between p-4 rounded-lg"
                    style={{ background: 'var(--bg-tertiary)' }}
                  >
                    <div className="flex items-center gap-3">
                      {check.ok ? (
                        <CheckCircle className="h-5 w-5 text-emerald-400" />
                      ) : (
                        <XCircle className="h-5 w-5 text-red-400" />
                      )}
                      <div>
                        <p className="font-medium capitalize" style={{ color: 'var(--text-primary)' }}>
                          {key === 'database' ? '数据库连接' :
                           key === 'aiModels' ? 'AI 模型配置' :
                           key === 'apiKey' ? 'API 密钥' : key}
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          {check.message}
                        </p>
                      </div>
                    </div>
                    <Badge className={check.ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}>
                      {check.ok ? '正常' : '异常'}
                    </Badge>
                  </div>
                ))}
                {healthCheck?.timestamp && (
                  <p className="text-xs text-right" style={{ color: 'var(--text-disabled)' }}>
                    上次检查: {new Date(healthCheck.timestamp).toLocaleString('zh-CN')}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="space-y-6">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <History className="h-5 w-5" />
                近期运行记录
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(recentRuns ?? []).length === 0 ? (
                  <p className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>
                    暂无运行记录
                  </p>
                ) : (
                  (recentRuns ?? []).map((run) => (
                    <div
                      key={run.batchId}
                      className="flex items-center justify-between p-4 rounded-lg"
                      style={{ background: 'var(--bg-tertiary)' }}
                    >
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-[var(--color-primary-20)]">
                          <Activity className="h-4 w-4 text-[var(--color-primary)]" />
                        </div>
                        <div>
                          <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {run.runType === 'manual' ? '手动运行' : run.runType === 'cron' ? '定时任务' : 'CI 测试'}
                          </p>
                          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            {new Date(run.createdAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge className="bg-[var(--bg-secondary)]" style={{ color: 'var(--text-secondary)' }}>
                          {run.testCount} 项测试
                        </Badge>
                        <span className="text-xs font-mono" style={{ color: 'var(--text-disabled)' }}>
                          {run.batchId.substring(0, 20)}...
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Stats Card */}
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <TrendingUp className="h-5 w-5" />
                24 小时统计
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总测试数</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summaryStats?.total_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>通过</p>
                  <p className="text-2xl font-bold text-emerald-400">
                    {summaryStats?.passed_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>失败</p>
                  <p className="text-2xl font-bold text-red-400">
                    {summaryStats?.failed_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>平均耗时</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summaryStats?.avg_latency_ms ?? 0}ms
                  </p>
                </div>
              </div>
              {summaryStats?.last_run && (
                <p className="text-xs text-right mt-4" style={{ color: 'var(--text-disabled)' }}>
                  上次运行: {new Date(summaryStats.last_run).toLocaleString('zh-CN')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
