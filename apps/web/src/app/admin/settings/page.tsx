'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/trpc/client';
import { Settings, Save, RefreshCw } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import AdminSidebar from '@/components/admin/AdminSidebar';

interface SettingItem {
  key: string;
  label: string;
  type: 'text' | 'number' | 'textarea' | 'boolean';
  description?: string;
}

const settingDefinitions: SettingItem[] = [
  { key: 'site_name', label: '站点名称', type: 'text', description: '显示在页面标题和Logo处' },
  { key: 'site_description', label: '站点描述', type: 'textarea', description: 'SEO描述和元信息' },
  { key: 'registration_enabled', label: '开放注册', type: 'boolean', description: '是否允许新用户注册' },
  { key: 'invitation_required', label: '邀请码注册', type: 'boolean', description: '注册时是否需要邀请码' },
  { key: 'default_credits', label: '新用户初始积分', type: 'number', description: '新用户注册时获得的初始积分' },
  { key: 'announcement_text', label: '全局公告', type: 'textarea', description: '显示在顶部横幅的公告内容' },
];

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [pendingChanges, setPendingChanges] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = trpc.settings.getSystemSettings.useQuery();

  const updateSetting = trpc.settings.updateSystemSettings.useMutation({
    onSuccess: () => {
      refetch();
      setSavingKey(null);
    },
    onError: () => {
      setSavingKey(null);
    }
  });

  useEffect(() => {
    if (data) {
      setSettings(data);
    }
  }, [data]);

  const handleChange = (key: string, value: unknown) => {
    setPendingChanges(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = (key: string) => {
    if (pendingChanges[key] === undefined) return;

    setSavingKey(key);
    updateSetting.mutate({
      key,
      value: pendingChanges[key],
    });

    // Update local state
    setSettings(prev => ({ ...prev, [key]: pendingChanges[key] }));
    setPendingChanges(prev => {
      const newPending = { ...prev };
      delete newPending[key];
      return newPending;
    });
  };

  const getValue = (key: string) => {
    if (pendingChanges[key] !== undefined) {
      return pendingChanges[key];
    }
    return settings[key] ?? '';
  };

  const hasChanges = (key: string) => pendingChanges[key] !== undefined;

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
              系统设置
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              管理平台全局配置
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

        {/* Settings Cards */}
        <div className="grid gap-6 max-w-3xl">
          {settingDefinitions.map((setting) => (
            <Card
              key={setting.key}
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
            >
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-lg" style={{ color: 'var(--text-primary)' }}>
                  <Settings className="h-5 w-5 text-[var(--color-primary)]" />
                  {setting.label}
                </CardTitle>
                {setting.description && (
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    {setting.description}
                  </p>
                )}
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-4">
                  <div className="flex-1">
                    {setting.type === 'textarea' ? (
                      <Textarea
                        value={String(getValue(setting.key) || '')}
                        onChange={(e) => handleChange(setting.key, e.target.value)}
                        className="min-h-[100px] bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                      />
                    ) : setting.type === 'boolean' ? (
                      <div className="flex items-center gap-4">
                        <Button
                          variant={getValue(setting.key) === true ? 'default' : 'outline'}
                          onClick={() => handleChange(setting.key, true)}
                          className={getValue(setting.key) === true
                            ? 'bg-[var(--color-primary)] text-black'
                            : 'border-[var(--border-primary)] text-[var(--text-secondary)]'
                          }
                        >
                          启用
                        </Button>
                        <Button
                          variant={getValue(setting.key) === false ? 'default' : 'outline'}
                          onClick={() => handleChange(setting.key, false)}
                          className={getValue(setting.key) === false
                            ? 'bg-rose-500 text-white'
                            : 'border-[var(--border-primary)] text-[var(--text-secondary)]'
                          }
                        >
                          禁用
                        </Button>
                      </div>
                    ) : (
                      <Input
                        type={setting.type}
                        value={String(getValue(setting.key) || '')}
                        onChange={(e) => handleChange(setting.key, setting.type === 'number' ? Number(e.target.value) : e.target.value)}
                        className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                      />
                    )}
                  </div>
                  <Button
                    onClick={() => handleSave(setting.key)}
                    disabled={!hasChanges(setting.key) || savingKey === setting.key}
                    className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 disabled:opacity-50"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {savingKey === setting.key ? '保存中...' : '保存'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
