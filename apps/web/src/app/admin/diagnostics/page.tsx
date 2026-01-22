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
  passed: { label: '\u901a\u8fc7', color: 'text-emerald-400', bgColor: 'bg-emerald-500/20', icon: CheckCircle },
  failed: { label: '\u5931\u8d25', color: 'text-red-400', bgColor: 'bg-red-500/20', icon: XCircle },
  warning: { label: '\u8b66\u544a', color: 'text-amber-400', bgColor: 'bg-amber-500/20', icon: AlertTriangle },
  skipped: { label: '\u8df3\u8fc7', color: 'text-gray-400', bgColor: 'bg-gray-500/20', icon: ChevronRight },
  error: { label: '\u9519\u8bef', color: 'text-red-400', bgColor: 'bg-red-500/20', icon: XCircle },
};

const categoryConfig: Record<DiagnosticCategory, { label: string; icon: React.ElementType; color: string }> = {
  ai: { label: 'AI \u529f\u80fd', icon: Brain, color: 'text-purple-400' },
  billing: { label: '\u8ba1\u8d39\u529f\u80fd', icon: DollarSign, color: 'text-emerald-400' },
  security: { label: '\u5b89\u5168\u529f\u80fd', icon: Shield, color: 'text-blue-400' },
  performance: { label: '\u6027\u80fd', icon: Zap, color: 'text-amber-400' },
  data: { label: '\u6570\u636e', icon: Database, color: 'text-cyan-400' },
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
                  \u5b8c\u6574\u6d88\u606f:
                </p>
                <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  {result.message}
                </p>
                {result.details && Object.keys(result.details).length > 0 && (
                  <>
                    <p className="text-sm font-medium mt-4" style={{ color: 'var(--text-secondary)' }}>
                      \u8be6\u7ec6\u4fe1\u606f:
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

  // Queries
  const { data: latestResults, refetch: refetchLatest } = trpc.diagnostics.getLatestResults.useQuery();
  const { data: summaryStats, refetch: refetchSummary } = trpc.diagnostics.getSummaryStats.useQuery();
  const { data: healthCheck, refetch: refetchHealth } = trpc.diagnostics.healthCheck.useQuery();
  const { data: recentRuns } = trpc.diagnostics.getRecentRuns.useQuery();
  const { data: testDefinitions } = trpc.diagnostics.getTestDefinitions.useQuery();

  // Mutations
  const runAllMutation = trpc.diagnostics.runAllTests.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
      refetchHealth();
      setIsRunning(false);
    },
    onError: () => {
      setIsRunning(false);
    },
  });

  const runCategoryMutation = trpc.diagnostics.runCategoryTests.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
      setIsRunning(false);
    },
    onError: () => {
      setIsRunning(false);
    },
  });

  const runSingleMutation = trpc.diagnostics.runSingleTest.useMutation({
    onSuccess: () => {
      refetchLatest();
      refetchSummary();
    },
  });

  const cleanupMutation = trpc.diagnostics.cleanupOldResults.useMutation({
    onSuccess: () => {
      refetchLatest();
    },
  });

  const handleRunAll = () => {
    setIsRunning(true);
    runAllMutation.mutate({});
  };

  const handleRunCategory = (category: DiagnosticCategory) => {
    setIsRunning(true);
    runCategoryMutation.mutate({ category });
  };

  const handleRunSingle = (testId: string) => {
    runSingleMutation.mutate({ testId });
  };

  const handleCleanup = () => {
    if (confirm('\u786e\u5b9a\u8981\u6e05\u7406 30 \u5929\u524d\u7684\u8bca\u65ad\u8bb0\u5f55\u5417\uff1f')) {
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
              \u7cfb\u7edf\u8bca\u65ad
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              \u4e00\u952e\u6d4b\u8bd5\u6240\u6709\u5173\u952e\u529f\u80fd\uff0c\u786e\u4fdd\u7cfb\u7edf\u5065\u5eb7\u8fd0\u884c
            </p>
          </div>
          {/* Health Status Badge */}
          <Badge className={`${healthBgColor} ${healthColor} px-3 py-1 text-sm`}>
            <Server className="h-4 w-4 mr-1" />
            \u7cfb\u7edf{healthStatus === 'healthy' ? '\u5065\u5eb7' : healthStatus === 'warning' ? '\u8b66\u544a' : '\u5f02\u5e38'}
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
            \u6e05\u7406\u65e7\u8bb0\u5f55
          </Button>
          <Button
            onClick={handleRunAll}
            disabled={isRunning}
            className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
          >
            {isRunning ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                \u8fd0\u884c\u4e2d...
              </>
            ) : (
              <>
                <PlayCircle className="h-4 w-4 mr-2" />
                \u8fd0\u884c\u6240\u6709\u6d4b\u8bd5
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u901a\u8fc7\u7387</p>
                <p className="text-3xl font-bold mt-1" style={{ color: 'var(--text-primary)' }}>
                  {summaryStats?.pass_rate ?? 0}%
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {summaryStats?.passed_tests ?? 0}/{summaryStats?.total_tests ?? 0} \u901a\u8fc7
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
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>AI \u529f\u80fd</p>
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
                  \u8fd0\u884c\u6d4b\u8bd5
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
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u8ba1\u8d39\u529f\u80fd</p>
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
                  \u8fd0\u884c\u6d4b\u8bd5
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
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u5b89\u5168\u529f\u80fd</p>
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
                  \u8fd0\u884c\u6d4b\u8bd5
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
            \u6d4b\u8bd5\u7ed3\u679c
          </TabsTrigger>
          <TabsTrigger value="health" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <Server className="h-4 w-4 mr-2" />
            \u5065\u5eb7\u68c0\u67e5
          </TabsTrigger>
          <TabsTrigger value="history" className="data-[state=active]:bg-[var(--bg-secondary)]">
            <History className="h-4 w-4 mr-2" />
            \u8fd0\u884c\u5386\u53f2
          </TabsTrigger>
        </TabsList>

        {/* Results Tab */}
        <TabsContent value="results" className="space-y-6">
          {/* Category Filter */}
          <div className="flex items-center gap-2">
            <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u7b5b\u9009:</span>
            <Button
              variant={selectedCategory === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedCategory('all')}
              className={selectedCategory === 'all' ? 'bg-[var(--color-primary)]' : ''}
            >
              \u5168\u90e8
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
                    <TableHead>\u6d4b\u8bd5\u540d\u79f0</TableHead>
                    <TableHead>\u7c7b\u522b</TableHead>
                    <TableHead>\u72b6\u6001</TableHead>
                    <TableHead>\u6d88\u606f</TableHead>
                    <TableHead>\u8017\u65f6</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredResults.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                        \u6682\u65e0\u6d4b\u8bd5\u7ed3\u679c\uff0c\u8bf7\u8fd0\u884c\u8bca\u65ad\u6d4b\u8bd5
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
                  \u7cfb\u7edf\u5065\u5eb7\u68c0\u67e5
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => refetchHealth()}
                  className="border-[var(--border-primary)]"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  \u5237\u65b0
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
                          {key === 'database' ? '\u6570\u636e\u5e93\u8fde\u63a5' :
                           key === 'aiModels' ? 'AI \u6a21\u578b\u914d\u7f6e' :
                           key === 'apiKey' ? 'API \u5bc6\u94a5' : key}
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          {check.message}
                        </p>
                      </div>
                    </div>
                    <Badge className={check.ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}>
                      {check.ok ? '\u6b63\u5e38' : '\u5f02\u5e38'}
                    </Badge>
                  </div>
                ))}
                {healthCheck?.timestamp && (
                  <p className="text-xs text-right" style={{ color: 'var(--text-disabled)' }}>
                    \u4e0a\u6b21\u68c0\u67e5: {new Date(healthCheck.timestamp).toLocaleString('zh-CN')}
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
                \u8fd1\u671f\u8fd0\u884c\u8bb0\u5f55
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(recentRuns ?? []).length === 0 ? (
                  <p className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>
                    \u6682\u65e0\u8fd0\u884c\u8bb0\u5f55
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
                            {run.runType === 'manual' ? '\u624b\u52a8\u8fd0\u884c' : run.runType === 'cron' ? '\u5b9a\u65f6\u4efb\u52a1' : 'CI \u6d4b\u8bd5'}
                          </p>
                          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            {new Date(run.createdAt).toLocaleString('zh-CN')}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <Badge className="bg-[var(--bg-secondary)]" style={{ color: 'var(--text-secondary)' }}>
                          {run.testCount} \u9879\u6d4b\u8bd5
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
                24 \u5c0f\u65f6\u7edf\u8ba1
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u603b\u6d4b\u8bd5\u6570</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summaryStats?.total_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u901a\u8fc7</p>
                  <p className="text-2xl font-bold text-emerald-400">
                    {summaryStats?.passed_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u5931\u8d25</p>
                  <p className="text-2xl font-bold text-red-400">
                    {summaryStats?.failed_tests ?? 0}
                  </p>
                </div>
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>\u5e73\u5747\u8017\u65f6</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {summaryStats?.avg_latency_ms ?? 0}ms
                  </p>
                </div>
              </div>
              {summaryStats?.last_run && (
                <p className="text-xs text-right mt-4" style={{ color: 'var(--text-disabled)' }}>
                  \u4e0a\u6b21\u8fd0\u884c: {new Date(summaryStats.last_run).toLocaleString('zh-CN')}
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
