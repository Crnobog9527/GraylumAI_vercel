'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Bot, Settings2, Zap, DollarSign, Check, X,
  MoreVertical
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import AdminSidebar from '@/components/admin/AdminSidebar';

interface AIModel {
  id: string;
  name: string;
  provider: string;
  model_id: string;
  enabled: boolean;
  credits_per_message: number;
  config: Record<string, unknown>;
  created_at: string;
}

const providerColors: Record<string, string> = {
  openai: 'bg-emerald-500/20 text-emerald-400',
  anthropic: 'bg-amber-500/20 text-amber-400',
  google: 'bg-blue-500/20 text-blue-400',
  default: 'bg-violet-500/20 text-violet-400',
};

export default function AdminModelsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<AIModel | null>(null);
  const [configJson, setConfigJson] = useState('');
  const [configError, setConfigError] = useState('');

  const { data: models, isLoading, error, refetch } = trpc.model.getAvailableModels.useQuery();

  const updateConfig = trpc.model.updateModelConfig.useMutation({
    onSuccess: () => {
      refetch();
      setDialogOpen(false);
      setSelectedModel(null);
      setConfigJson('');
      setConfigError('');
    },
    onError: (err) => {
      setConfigError(err.message);
    }
  });

  const openConfigDialog = (model: AIModel) => {
    setSelectedModel(model);
    setConfigJson(JSON.stringify(model.config || {}, null, 2));
    setConfigError('');
    setDialogOpen(true);
  };

  const handleSaveConfig = () => {
    if (!selectedModel) return;

    try {
      const parsedConfig = JSON.parse(configJson);
      updateConfig.mutate({
        id: selectedModel.id,
        config: parsedConfig,
      });
    } catch {
      setConfigError('JSON 格式无效');
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

  const modelList = models ?? [];

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
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
        </div>

        {/* Models Stats */}
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
                  <Zap className="h-6 w-6 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>已启用</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {modelList.filter((m: AIModel) => m.enabled).length}
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
                    {modelList.filter((m: AIModel) => !m.enabled).length}
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
                  <TableHead>积分消耗</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-[80px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {modelList.map((model: AIModel) => {
                  const providerColor = providerColors[model.provider?.toLowerCase()] || providerColors.default;
                  return (
                    <TableRow key={model.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="p-2 rounded-lg"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <Bot className="h-4 w-4 text-[var(--color-primary)]" />
                          </div>
                          <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                            {model.name}
                          </span>
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
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <DollarSign className="h-4 w-4 text-amber-400" />
                          <span style={{ color: 'var(--text-primary)' }}>
                            {model.credits_per_message ?? 1}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {model.enabled ? (
                          <Badge className="bg-emerald-500/20 text-emerald-400">
                            <Check className="h-3 w-3 mr-1" />
                            已启用
                          </Badge>
                        ) : (
                          <Badge className="bg-rose-500/20 text-rose-400">
                            <X className="h-3 w-3 mr-1" />
                            已禁用
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
                          >
                            <DropdownMenuItem
                              onClick={() => openConfigDialog(model)}
                              className="cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                            >
                              <Settings2 className="h-4 w-4 mr-2" />
                              编辑配置
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {modelList.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无 AI 模型
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Config Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent
            className="max-w-lg"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>编辑模型配置</DialogTitle>
            </DialogHeader>

            {selectedModel && (
              <div className="space-y-4 py-4">
                {/* Model Info */}
                <div
                  className="p-4 rounded-lg"
                  style={{ background: 'var(--bg-tertiary)' }}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-[var(--color-primary-20)]">
                      <Bot className="h-5 w-5 text-[var(--color-primary)]" />
                    </div>
                    <div>
                      <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                        {selectedModel.name}
                      </p>
                      <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        {selectedModel.provider} / {selectedModel.model_id}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Config JSON Editor */}
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>配置 (JSON)</Label>
                  <Textarea
                    value={configJson}
                    onChange={(e) => {
                      setConfigJson(e.target.value);
                      setConfigError('');
                    }}
                    className="min-h-[200px] font-mono text-sm bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                    placeholder="{}"
                  />
                  {configError && (
                    <p className="text-sm" style={{ color: 'var(--error)' }}>
                      {configError}
                    </p>
                  )}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
                className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
              >
                取消
              </Button>
              <Button
                onClick={handleSaveConfig}
                disabled={updateConfig.isPending}
                className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
              >
                {updateConfig.isPending ? '保存中...' : '保存配置'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
