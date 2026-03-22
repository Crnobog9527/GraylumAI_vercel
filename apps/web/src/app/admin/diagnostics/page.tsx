'use client';

import { useEffect, useState } from 'react';
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
// 移除 Collapsible 以避免在表格中产生 Hydration 错误
// import {
//   Collapsible,
//   CollapsibleContent,
//   CollapsibleTrigger,
// } from "@/components/ui/collapsible";
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
    <>
      <TableRow className="hover:bg-[var(--bg-tertiary)]">
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            className="p-0 h-auto"
            onClick={() => setIsOpen(!isOpen)}
          >
            {isOpen ? (
              <ChevronDown className="h-4 w-4 text-[var(--text-tertiary)]" />
            ) : (
              <ChevronRight className="h-4 w-4 text-[var(--text-tertiary)]" />
            )}
          </Button>
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
      {isOpen && (
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
      )}
    </>
  );
}

interface RunResult {
  batchId: string;
  runAt: Date;
  runType: 'manual' | 'cron' | 'ci';
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warning: number;
    skipped: number;
    error: number;
    passRate: number;
    avgLatencyMs: number;
  };
  saveStatus?: {
    saved: boolean;
    error?: string;
  };
}

interface RuntimeProof {
  found: boolean;
  status: DiagnosticStatus;
  message: string;
  checkedAt: string;
  usageLog?: Record<string, unknown>;
  tokenStats?: Record<string, unknown>;
  settle?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  snapshots?: {
    searchDigest: boolean;
    compressionCheckpoint: boolean;
    rollingSummary: boolean;
  };
  checks?: Record<string, boolean>;
}

export default function AdminDiagnosticsPage() {
  const [isRunning, setIsRunning] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<DiagnosticCategory | 'all'>('all');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [localResults, setLocalResults] = useState<TestResult[]>([]);
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);

  // Queries
  const { data: latestResults, refetch: refetchLatest, error: latestError } = trpc.diagnostics.getLatestResults.useQuery();
  const { data: summaryStats, refetch: refetchSummary, error: summaryError } = trpc.diagnostics.getSummaryStats.useQuery();
  const { data: healthCheck, refetch: refetchHealth, error: healthError } = trpc.diagnostics.healthCheck.useQuery();
  const { data: runtimeProof, refetch: refetchRuntimeProof } = trpc.diagnostics.getLatestRuntimeProof.useQuery();
  const { data: recentRuns } = trpc.diagnostics.getRecentRuns.useQuery();
  const { data: testDefinitions } = trpc.diagnostics.getTestDefinitions.useQuery();

  const queryErrorMessage =
    latestError?.message ?? summaryError?.message ?? healthError?.message ?? null;

  useEffect(() => {
    if (queryErrorMessage) {
      setErrorMessage(queryErrorMessage);
    }
  }, [queryErrorMessage]);

  // Mutations
  const runAllMutation = trpc.diagnostics.runAllTests.useMutation({
    onSuccess: (data) => {
      // 直接使用返回的结果，不依赖数据库
      if (data && data.results) {
        setLocalResults(data.results);
      }
      // 检查保存状态
      if (data?.saveStatus && !data.saveStatus.saved) {
        setSaveWarning(`数据库保存失败: ${data.saveStatus.error || '未知错误'}`);
      } else {
        setSaveWarning(null);
      }
      refetchLatest();
      refetchSummary();
      refetchHealth();
      refetchRuntimeProof();
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
    onSuccess: (data) => {
      if (data && data.results) {
        setLocalResults(data.results);
      }
      // 检查保存状态
      if (data?.saveStatus && !data.saveStatus.saved) {
        setSaveWarning(`数据库保存失败: ${data.saveStatus.error || '未知错误'}`);
      } else {
        setSaveWarning(null);
      }
      refetchLatest();
      refetchSummary();
      refetchRuntimeProof();
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
    onSuccess: (data) => {
      if (data) {
        // 更新本地结果中的对应测试
        setLocalResults(prev => {
          const existing = prev.findIndex(r => r.testId === data.testId);
          if (existing >= 0) {
            const updated = [...prev];
            updated[existing] = data;
            return updated;
          }
          return [...prev, data];
        });
      }
      refetchLatest();
      refetchSummary();
      refetchRuntimeProof();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error.message || '运行测试失败');
      console.error('runSingleTest error:', error);
    },
  });

  const cleanupMutation = trpc.diagnostics.cleanupOldResults.useMutation({
    onSuccess: (data) => {
      setCleanupStatus(`${data.message}，本次处理 ${data.deletedCount} 条记录`);
      refetchLatest();
      refetchSummary();
    },
    onError: (error) => {
      setCleanupStatus(error.message || '诊断记录清理失败');
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
    if (confirm('确定要清理 30 天前的诊断记录吗？')) {
      cleanupMutation.mutate({});
    }
  };

  // 优先使用本地结果（mutation 返回的），否则使用数据库查询结果
  const displayResults = localResults.length > 0 ? localResults : (latestResults ?? []);

  // Filter results by category
  const filteredResults = selectedCategory === 'all'
    ? displayResults
    : displayResults.filter(r => r.category === selectedCategory);

  // Calculate category stats - 使用 displayResults
  const categoryStats = {
    ai: { total: 0, passed: 0 },
    billing: { total: 0, passed: 0 },
    security: { total: 0, passed: 0 },
  };

  displayResults.forEach(r => {
    if (r.category in categoryStats) {
      categoryStats[r.category as keyof typeof categoryStats].total++;
      if (r.status === 'passed') {
        categoryStats[r.category as keyof typeof categoryStats].passed++;
      }
    }
  });

  // 计算本地摘要统计
  const localSummary = localResults.length > 0 ? {
    total_tests: localResults.length,
    passed_tests: localResults.filter(r => r.status === 'passed').length,
    failed_tests: localResults.filter(r => r.status === 'failed').length,
    warning_tests: localResults.filter(r => r.status === 'warning').length,
    pass_rate: Math.round((localResults.filter(r => r.status === 'passed').length / localResults.length) * 100),
    avg_latency_ms: Math.round(localResults.reduce((sum, r) => sum + r.latencyMs, 0) / localResults.length),
    last_run: new Date().toISOString(),
  } : null;

  // 优先使用本地摘要
  const displaySummary = localSummary || summaryStats;
  const showingCurrentRun = localResults.length > 0;
  const persistedFailedCount = (latestResults ?? []).filter((result) => result.status === 'failed' || result.status === 'error').length;
  const latestPersistedRun = (recentRuns ?? [])[0];

  // Health status
  const healthStatus = healthCheck?.status ?? 'healthy';
  const healthColor = healthStatus === 'healthy' ? 'text-emerald-400' : healthStatus === 'warning' ? 'text-amber-400' : 'text-red-400';
  const healthBgColor = healthStatus === 'healthy' ? 'bg-emerald-500/20' : healthStatus === 'warning' ? 'bg-amber-500/20' : 'bg-red-500/20';
  const runtimeProofData = runtimeProof as RuntimeProof | undefined;
  const runtimeProofRequestId =
    runtimeProofData?.usageLog && typeof runtimeProofData.usageLog.request_id === 'string'
      ? runtimeProofData.usageLog.request_id
      : null;
  const runtimeProofModelId =
    runtimeProofData?.usageLog && typeof runtimeProofData.usageLog.model_id === 'string'
      ? runtimeProofData.usageLog.model_id
      : null;
  const runtimeProofCredits =
    runtimeProofData?.tokenStats && runtimeProofData.tokenStats.total_credits !== undefined
      ? String(runtimeProofData.tokenStats.total_credits)
      : '--';
  const runtimeProofSearchCount =
    runtimeProofData?.tokenStats && runtimeProofData.tokenStats.web_search_count !== undefined
      ? String(runtimeProofData.tokenStats.web_search_count)
      : '--';
  const runtimeProofStatus = runtimeProofData?.status ?? 'warning';
  const runtimeProofChecks = Object.entries(runtimeProofData?.checks ?? {});
  const runtimeProofOkCount = runtimeProofChecks.filter(([, ok]) => ok).length;
  const runtimeProofColor =
    runtimeProofStatus === 'passed'
      ? 'text-emerald-400'
      : runtimeProofStatus === 'warning'
        ? 'text-amber-400'
        : runtimeProofStatus === 'error'
          ? 'text-red-400'
          : 'text-red-400';
  const runtimeProofBg =
    runtimeProofStatus === 'passed'
      ? 'bg-emerald-500/20'
      : runtimeProofStatus === 'warning'
        ? 'bg-amber-500/20'
        : 'bg-red-500/20';

  return (
    <div className="space-y-6 p-4 md:p-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div>
            <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>
              系统诊断
            </h1>
              <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                一键测试所有关键功能，确保系统健康运行
              </p>
              <p className="mt-2 text-sm" style={{ color: 'var(--text-disabled)' }}>
                本页会区分“本次运行结果”和“最近一次已持久化历史”，避免把旧失败误当成当前运行失败。
              </p>
            </div>
          {/* Health Status Badge */}
          <Badge className={`${healthBgColor} ${healthColor} px-3 py-1 text-sm`}>
            <Server className="h-4 w-4 mr-1" />
            系统{healthStatus === 'healthy' ? '健康' : healthStatus === 'warning' ? '警告' : '异常'}
          </Badge>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button
            data-testid="admin-diagnostics-cleanup-trigger"
            variant="outline"
            onClick={handleCleanup}
            disabled={cleanupMutation.isPending}
            className="w-full border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] sm:w-auto"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            清理旧记录
          </Button>
          <Button
            onClick={handleRunAll}
            disabled={isRunning}
            className="w-full bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white sm:w-auto"
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
      <div className="mb-4 text-sm" data-testid="admin-diagnostics-cleanup-status" style={{ color: 'var(--text-secondary)' }}>
        {cleanupStatus || '尚未执行诊断记录清理'}
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div className="mb-6 p-4 rounded-lg bg-red-500/20 border border-red-500/30">
          <div className="flex items-center gap-3">
            <XCircle className="h-5 w-5 text-red-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-red-400">本次运行失败</p>
              <p className="text-sm text-red-300 mt-1">{errorMessage}</p>
              <p className="text-xs text-red-300/70 mt-1">最近一次已持久化历史结果仍会保留在下方历史区域。</p>
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

      {/* Save Warning */}
      {saveWarning && (
        <div className="mb-6 p-4 rounded-lg bg-amber-500/20 border border-amber-500/30">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="font-medium text-amber-400">测试结果未持久化</p>
              <p className="text-sm text-amber-300 mt-1">{saveWarning}</p>
              <p className="text-xs text-amber-300/70 mt-1">测试已执行成功，但结果未保存到数据库。刷新页面后数据将丢失。</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSaveWarning(null)}
              className="text-amber-400 hover:text-amber-300"
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
                  {displaySummary?.pass_rate ?? 0}%
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                  {displaySummary?.passed_tests ?? 0}/{displaySummary?.total_tests ?? 0} 通过
                </p>
              </div>
              <div className={`p-3 rounded-xl ${(displaySummary?.pass_rate ?? 0) >= 80 ? 'bg-emerald-500/20' : 'bg-amber-500/20'}`}>
                <Gauge className={`h-6 w-6 ${(displaySummary?.pass_rate ?? 0) >= 80 ? 'text-emerald-400' : 'text-amber-400'}`} />
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

      <Card
        className="mb-8"
        data-testid="runtime-proof-card"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
      >
        <CardContent className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className={`p-3 rounded-xl ${runtimeProofBg}`}>
                  <Activity className={`h-6 w-6 ${runtimeProofColor}`} />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>最新真实运行证据</p>
                  <p
                    className="text-xl font-semibold"
                    data-testid="runtime-proof-message"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {runtimeProofData?.message ?? '尚未加载'}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <Badge
                  className={`${runtimeProofBg} ${runtimeProofColor}`}
                  data-testid="runtime-proof-status"
                >
                  {statusConfig[runtimeProofStatus].label}
                </Badge>
                <span>校验项 {runtimeProofOkCount}/{runtimeProofChecks.length || 0}</span>
                {runtimeProofRequestId && (
                  <span className="font-mono">request {runtimeProofRequestId.slice(0, 18)}...</span>
                )}
                {runtimeProofModelId && (
                  <span>model {runtimeProofModelId}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchRuntimeProof()}
                className="border-[var(--border-primary)]"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                刷新证据
              </Button>
            </div>
          </div>

          {runtimeProofChecks.length > 0 && (
            <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              {runtimeProofChecks.map(([key, ok]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {key}
                  </span>
                  <Badge className={ok ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}>
                    {ok ? '一致' : '异常'}
                  </Badge>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
            <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>搜索快照</p>
              <p style={{ color: 'var(--text-primary)' }}>
                {runtimeProofData?.snapshots?.searchDigest ? '存在' : '无'}
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>压缩快照</p>
              <p style={{ color: 'var(--text-primary)' }}>
                {runtimeProofData?.snapshots?.compressionCheckpoint ? '存在' : '无'}
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>积分</p>
              <p style={{ color: 'var(--text-primary)' }}>
                {runtimeProofCredits}
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--bg-tertiary)' }}>
              <p style={{ color: 'var(--text-tertiary)' }}>联网次数</p>
              <p style={{ color: 'var(--text-primary)' }}>
                {runtimeProofSearchCount}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="results" className="space-y-6">
        <TabsList className="flex h-auto justify-start gap-1 overflow-x-auto bg-[var(--bg-tertiary)] p-1">
          <TabsTrigger value="results" className="shrink-0 data-[state=active]:bg-[var(--bg-secondary)]">
            <Activity className="h-4 w-4 mr-2" />
            测试结果
          </TabsTrigger>
          <TabsTrigger value="health" className="shrink-0 data-[state=active]:bg-[var(--bg-secondary)]">
            <Server className="h-4 w-4 mr-2" />
            健康检查
          </TabsTrigger>
          <TabsTrigger value="history" className="shrink-0 data-[state=active]:bg-[var(--bg-secondary)]">
            <History className="h-4 w-4 mr-2" />
            运行历史
          </TabsTrigger>
        </TabsList>

        {/* Results Tab */}
        <TabsContent value="results" className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-4">
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>当前展示结果</p>
                <p className="mt-1 font-medium" style={{ color: 'var(--text-primary)' }}>
                  {showingCurrentRun ? '本次运行结果' : '最近一次已持久化结果'}
                </p>
              </CardContent>
            </Card>
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="p-4">
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>最近一次已持久化运行</p>
                <p className="mt-1 font-medium" style={{ color: 'var(--text-primary)' }}>
                  {latestPersistedRun
                    ? `${new Date(latestPersistedRun.createdAt).toLocaleString('zh-CN')} · 失败项 ${persistedFailedCount}`
                    : '暂无历史记录'}
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Category Filter */}
          <div className="flex flex-wrap items-center gap-2">
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
          <Card data-testid="admin-diagnostics-results-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
              <Table className="min-w-[920px]">
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
              </div>
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
