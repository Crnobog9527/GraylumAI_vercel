'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Bot, Plus, Pencil, Trash2, Sparkles, Brain, Zap,
  Check, X, Loader2, Globe, RefreshCw, AlertTriangle, HelpCircle
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

interface AIModel {
  id: string;
  name: string;
  model_id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';
  api_key?: string;
  api_endpoint?: string;
  description?: string;
  max_tokens: number;
  input_limit: number;
  enable_web_search: string;
  input_token_cost: number;
  output_token_cost: number;
  input_token_cost_above_200k: number;
  output_token_cost_above_200k: number;
  web_search_cost: number;
  is_active: string;
  config?: Record<string, unknown>;
  created_at: string;
}

const providerIcons = {
  anthropic: Sparkles,
  google: Brain,
  openai: Zap,
  custom: Bot,
  builtin: Globe,
};

const providerColors: Record<string, string> = {
  anthropic: 'bg-amber-500/20 text-amber-400',
  openai: 'bg-emerald-500/20 text-emerald-400',
  google: 'bg-blue-500/20 text-blue-400',
  custom: 'bg-violet-500/20 text-violet-400',
  builtin: 'bg-cyan-500/20 text-cyan-400',
};

type ProviderType = 'anthropic' | 'openai' | 'google' | 'custom' | 'builtin';

interface FormData {
  name: string;
  modelId: string;
  provider: ProviderType;
  apiKey: string;
  apiEndpoint: string;
  description: string;
  maxTokens: number;
  inputLimit: number;
  enableWebSearch: boolean;
  inputTokenCost: number;
  outputTokenCost: number;
  inputTokenCostAbove200k: number;
  outputTokenCostAbove200k: number;
  webSearchCost: number;
}

const initialFormData: FormData = {
  name: '',
  modelId: '',
  provider: 'anthropic',
  apiKey: '',
  apiEndpoint: '',
  description: '',
  maxTokens: 4096,
  inputLimit: 180000,
  enableWebSearch: false,
  inputTokenCost: 0,
  outputTokenCost: 0,
  inputTokenCostAbove200k: 0,
  outputTokenCostAbove200k: 0,
  webSearchCost: 0,
};

export default function AdminModelsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(null);
  const [formData, setFormData] = useState(initialFormData);

  const [testingModelId, setTestingModelId] = useState<string | null>(null);

  const { data: models, isLoading, error, refetch } = trpc.model.getAvailableModels.useQuery();
  const { data: connectionStatus, refetch: refetchStatus } = trpc.model.getConnectionStatus.useQuery();

  const createModel = trpc.model.createModel.useMutation({
    onSuccess: () => {
      refetch();
      refetchStatus();
      closeDialog();
    },
  });

  const updateModel = trpc.model.updateModel.useMutation({
    onSuccess: () => {
      refetch();
      refetchStatus();
      closeDialog();
    },
  });

  const deleteModel = trpc.model.deleteModel.useMutation({
    onSuccess: () => {
      refetch();
      refetchStatus();
      setDeleteDialogOpen(false);
      setSelectedModel(null);
    },
  });

  const testConnection = trpc.model.testConnection.useMutation({
    onSuccess: () => {
      refetchStatus();
      setTestingModelId(null);
    },
    onError: () => {
      setTestingModelId(null);
    },
  });

  const handleTestConnection = (modelId: string) => {
    setTestingModelId(modelId);
    testConnection.mutate({ id: modelId });
  };

  const getConnectionStatusInfo = (modelId: string) => {
    const status = connectionStatus?.find(s => s.id === modelId);
    if (!status) return { label: '未知', color: 'bg-gray-500/20 text-gray-400', icon: HelpCircle };

    if (!status.hasApiKey) {
      return { label: '未配置密钥', color: 'bg-rose-500/20 text-rose-400', icon: X };
    }

    switch (status.connectionStatus) {
      case 'connected':
        return { label: '已连接', color: 'bg-emerald-500/20 text-emerald-400', icon: Check };
      case 'error':
        return { label: '连接失败', color: 'bg-rose-500/20 text-rose-400', icon: AlertTriangle };
      case 'untested':
        return { label: '待测试', color: 'bg-amber-500/20 text-amber-400', icon: HelpCircle };
      default:
        return { label: '未知', color: 'bg-gray-500/20 text-gray-400', icon: HelpCircle };
    }
  };

  const resetForm = () => {
    setFormData(initialFormData);
    setSelectedModel(null);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  const openCreateDialog = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (model: AIModel) => {
    setSelectedModel(model);
    setFormData({
      name: model.name || '',
      modelId: model.model_id || '',
      provider: model.provider || 'anthropic',
      apiKey: model.api_key || '',
      apiEndpoint: model.api_endpoint || '',
      description: model.description || '',
      maxTokens: model.max_tokens || 4096,
      inputLimit: model.input_limit || 180000,
      enableWebSearch: model.enable_web_search === 'true',
      inputTokenCost: (model.input_token_cost || 0) / 100,
      outputTokenCost: (model.output_token_cost || 0) / 100,
      inputTokenCostAbove200k: (model.input_token_cost_above_200k || 0) / 100,
      outputTokenCostAbove200k: (model.output_token_cost_above_200k || 0) / 100,
      webSearchCost: (model.web_search_cost || 0) / 100,
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (selectedModel) {
      updateModel.mutate({
        id: selectedModel.id,
        ...formData,
      });
    } else {
      createModel.mutate(formData);
    }
  };

  const handleToggleActive = (model: AIModel) => {
    updateModel.mutate({
      id: model.id,
      isActive: model.is_active !== 'true',
    });
  };

  const handleDelete = (model: AIModel) => {
    setSelectedModel(model);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (selectedModel) {
      deleteModel.mutate({ id: selectedModel.id });
    }
  };

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  const modelList = (models ?? []) as AIModel[];
  const activeCount = modelList.filter(m => m.is_active === 'true').length;

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              AI 模型管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理可用的 AI 模型和配置
            </p>
          </div>
          <Button
            onClick={openCreateDialog}
            className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
          >
            <Plus className="h-4 w-4 mr-2" />
            添加模型
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                  <Bot className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总模型数</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {modelList.length}
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
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已禁用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {modelList.length - activeCount}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Models Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模型名称</TableHead>
                  <TableHead>提供商</TableHead>
                  <TableHead>模型 ID</TableHead>
                  <TableHead>Token 限制</TableHead>
                  <TableHead>联网搜索</TableHead>
                  <TableHead>API 状态</TableHead>
                  <TableHead>启用状态</TableHead>
                  <TableHead className="w-[150px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelList.map((model) => {
                  const Icon = providerIcons[model.provider] || Bot;
                  const providerColor = providerColors[model.provider] || providerColors.custom;
                  return (
                    <TableRow key={model.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="p-2 rounded-lg"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <Icon className="h-4 w-4 text-[var(--color-primary)]" />
                          </div>
                          <div>
                            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {model.name}
                            </span>
                            {model.description && (
                              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {model.description.substring(0, 40)}...
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={providerColor}>
                          {model.provider}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <code
                          className="text-xs px-2 py-1 rounded"
                          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                        >
                          {model.model_id}
                        </code>
                      </TableCell>
                      <TableCell style={{ color: 'var(--text-secondary)' }}>
                        {model.max_tokens?.toLocaleString()} / {(model.input_limit / 1000).toFixed(0)}K
                      </TableCell>
                      <TableCell>
                        {model.enable_web_search === 'true' ? (
                          <Badge className="bg-cyan-500/20 text-cyan-400">
                            <Globe className="h-3 w-3 mr-1" />
                            已启用
                          </Badge>
                        ) : (
                          <span style={{ color: 'var(--text-disabled)' }}>-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {(() => {
                          const statusInfo = getConnectionStatusInfo(model.id);
                          const StatusIcon = statusInfo.icon;
                          return (
                            <Badge className={statusInfo.color}>
                              <StatusIcon className="h-3 w-3 mr-1" />
                              {statusInfo.label}
                            </Badge>
                          );
                        })()}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={model.is_active === 'true'
                            ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                            : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                          }
                          onClick={() => handleToggleActive(model)}
                        >
                          {model.is_active === 'true' ? (
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
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleTestConnection(model.id)}
                            disabled={testingModelId === model.id}
                            className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                            title="测试 API 连接"
                          >
                            {testingModelId === model.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditDialog(model)}
                            className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDelete(model)}
                            className="h-8 w-8 text-rose-400 hover:bg-rose-500/20"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {modelList.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无 AI 模型，点击上方按钮添加
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
            className="max-w-lg max-h-[90vh] overflow-y-auto"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {selectedModel ? '编辑模型' : '添加模型'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>显示名称</Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="Claude 4.5 Sonnet"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>模型 ID</Label>
                  <Input
                    value={formData.modelId}
                    onChange={(e) => setFormData({ ...formData, modelId: e.target.value })}
                    placeholder="claude-4.5-sonnet"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>提供商</Label>
                <Select
                  value={formData.provider}
                  onValueChange={(value: typeof formData.provider) => setFormData({ ...formData, provider: value })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                    <SelectItem value="openai">OpenAI (GPT)</SelectItem>
                    <SelectItem value="google">Google (Gemini)</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                    <SelectItem value="builtin">内置 (支持联网)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>API Key</Label>
                <Input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                  placeholder="sk-..."
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>API Endpoint (可选)</Label>
                <Input
                  value={formData.apiEndpoint}
                  onChange={(e) => setFormData({ ...formData, apiEndpoint: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>最大输出 Token</Label>
                  <Input
                    type="number"
                    value={formData.maxTokens}
                    onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) || 4096 })}
                    min={256}
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>上下文限制</Label>
                  <Input
                    type="number"
                    value={formData.inputLimit}
                    onChange={(e) => setFormData({ ...formData, inputLimit: parseInt(e.target.value) || 180000 })}
                    min={1000}
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>描述</Label>
                <Textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="模型简介..."
                  rows={2}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div
                className="flex items-center justify-between p-3 rounded-lg"
                style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}
              >
                <div>
                  <Label style={{ color: 'var(--text-primary)' }}>启用联网搜索</Label>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {formData.provider === 'builtin'
                      ? '使用平台内置LLM的联网能力'
                      : '通过OpenRouter实现联网搜索'}
                  </p>
                </div>
                <Switch
                  checked={formData.enableWebSearch}
                  onCheckedChange={(checked) => setFormData({ ...formData, enableWebSearch: checked })}
                />
              </div>

              {/* Token Cost Settings */}
              <div
                className="p-4 rounded-lg space-y-4"
                style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)' }}
              >
                <Label className="text-amber-400 font-medium">Token 成本设置</Label>

                {/* ≤200K tokens */}
                <div className="space-y-2">
                  <p className="text-xs text-amber-300 font-medium">≤ 200K tokens</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">输入成本 ($/1M)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.inputTokenCost}
                        onChange={(e) => setFormData({ ...formData, inputTokenCost: parseFloat(e.target.value) || 0 })}
                        className="h-9 bg-[var(--bg-tertiary)] border-amber-500/30 text-[var(--text-primary)]"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">输出成本 ($/1M)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.outputTokenCost}
                        onChange={(e) => setFormData({ ...formData, outputTokenCost: parseFloat(e.target.value) || 0 })}
                        className="h-9 bg-[var(--bg-tertiary)] border-amber-500/30 text-[var(--text-primary)]"
                      />
                    </div>
                  </div>
                </div>

                {/* >200K tokens */}
                <div className="space-y-2 pt-2 border-t border-amber-500/20">
                  <p className="text-xs text-amber-300 font-medium">&gt; 200K tokens</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">输入成本 ($/1M)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.inputTokenCostAbove200k}
                        onChange={(e) => setFormData({ ...formData, inputTokenCostAbove200k: parseFloat(e.target.value) || 0 })}
                        className="h-9 bg-[var(--bg-tertiary)] border-amber-500/30 text-[var(--text-primary)]"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">输出成本 ($/1M)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.outputTokenCostAbove200k}
                        onChange={(e) => setFormData({ ...formData, outputTokenCostAbove200k: parseFloat(e.target.value) || 0 })}
                        className="h-9 bg-[var(--bg-tertiary)] border-amber-500/30 text-[var(--text-primary)]"
                      />
                    </div>
                  </div>
                </div>

                {/* Web Search Cost */}
                <div className="space-y-2 pt-2 border-t border-amber-500/20">
                  <p className="text-xs text-amber-300 font-medium">联网搜索成本</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">搜索成本 ($/1K次)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={formData.webSearchCost}
                        onChange={(e) => setFormData({ ...formData, webSearchCost: parseFloat(e.target.value) || 0 })}
                        className="h-9 bg-[var(--bg-tertiary)] border-amber-500/30 text-[var(--text-primary)]"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-amber-200">每次成本</Label>
                      <div
                        className="h-9 px-3 flex items-center rounded-md"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <span className="text-amber-400 font-medium">
                          ${((formData.webSearchCost || 0) / 1000).toFixed(4)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
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
                disabled={!formData.name || !formData.modelId || createModel.isPending || updateModel.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {(createModel.isPending || updateModel.isPending) ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    保存中...
                  </>
                ) : (
                  selectedModel ? '更新' : '创建'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <AlertDialogHeader>
              <AlertDialogTitle style={{ color: 'var(--text-primary)' }}>删除模型</AlertDialogTitle>
              <AlertDialogDescription style={{ color: 'var(--text-tertiary)' }}>
                确定要删除模型 &quot;{selectedModel?.name}&quot; 吗？此操作无法撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmDelete}
                className="bg-rose-600 text-white hover:bg-rose-700"
              >
                {deleteModel.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    删除中...
                  </>
                ) : (
                  '确认删除'
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </div>
  );
}
