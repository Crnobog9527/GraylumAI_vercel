'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/trpc/client';
import {
  Save, RefreshCw, Settings, CreditCard, Gift, Users, Sliders, Crown,
  Trash2, Download, Clock, AlertTriangle, CheckCircle, MessageSquare
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { DEFAULT_SITE_NAME, DEFAULT_SUPPORT_EMAIL } from '@/lib/site-config';
import { getSafeErrorMessage } from '@/lib/safe-error-message';

// 完整的系统设置定义
const defaultSettings: Record<string, { value: string; type: 'string' | 'number' | 'boolean'; label: string; description: string }> = {
  // General (3项)
  site_name: { value: DEFAULT_SITE_NAME, type: 'string', label: '平台名称', description: '显示在全站的平台名称' },
  support_email: { value: DEFAULT_SUPPORT_EMAIL, type: 'string', label: '客服邮箱', description: '用户支持咨询邮箱' },
  maintenance_mode: { value: 'false', type: 'boolean', label: '维护模式', description: '开启后向用户显示维护信息' },

  // Credits & Billing
  new_user_credits: { value: '100', type: 'number', label: '新用户赠送积分', description: '新用户注册时赠送的积分数量' },
  billing_credits_per_usd: { value: '1000', type: 'number', label: '每美元积分数', description: 'AI 成本换算为站内积分的基准比例' },
  billing_token_price_multiplier: { value: '1.5', type: 'number', label: 'Token 成本倍率', description: '用户计费 = 供应商成本 × 每美元积分数 × 该倍率' },
  billing_min_pre_deduct: { value: '10', type: 'number', label: '最小预扣积分', description: 'AI 请求预扣的最低积分数，默认沿用现有安全值 10' },
  billing_max_pre_deduct: { value: '10000', type: 'number', label: '最大预扣积分', description: '单次 AI 请求预扣积分上限' },
  billing_safety_margin: { value: '0.2', type: 'number', label: '预扣安全边际', description: '预扣时在估算积分上额外增加的比例，例如 0.2 表示 20%' },
  billing_require_model_pricing: { value: 'true', type: 'boolean', label: '要求模型价格', description: '开启后模型价格缺失或为 0 时拒绝 AI 请求，不使用硬编码后备价格' },
  input_credits_per_1k: { value: '1', type: 'number', label: '输入Token积分单价', description: '每1000个输入Token消耗的积分数' },
  output_credits_per_1k: { value: '5', type: 'number', label: '输出Token积分单价', description: '每1000个输出Token消耗的积分数' },
  web_search_credits: { value: '5', type: 'number', label: '联网搜索积分', description: '每次启用联网搜索额外消耗的积分数' },
  first_purchase_bonus_percent: { value: '20', type: 'number', label: '首充赠送%', description: '历史兼容字段，当前运行时未消费该配置' },

  // Features (11项)
  max_messages_per_conversation: { value: '100', type: 'number', label: '单对话最大消息数', description: '每个对话允许的最大消息数' },
  max_input_characters: { value: '2000', type: 'number', label: '输入框字符上限', description: '用户单次输入的最大字符数' },
  enable_free_tier: { value: 'false', type: 'boolean', label: '启用免费体验', description: '允许用户在无积分时使用有限功能' },
  free_tier_messages: { value: '5', type: 'number', label: '免费消息数/天', description: '每天免费消息数量' },
  long_text_warning_threshold: { value: '5000', type: 'number', label: '长文本预警阈值(tokens)', description: '输入token超过此值时弹窗提示用户确认' },
  enable_long_text_warning: { value: 'true', type: 'boolean', label: '启用长文本预警', description: '开启后，超长文本会提示预计消耗积分' },
  show_token_usage_stats: { value: 'true', type: 'boolean', label: '显示Token使用统计', description: '在聊天页面显示本次请求和累计的Token使用情况' },
  chat_show_model_selector: { value: 'true', type: 'boolean', label: '显示模型选择器', description: '在聊天界面显示AI模型选择下拉框' },
  chat_prompt_text: { value: '请选择一个模型开始对话', type: 'string', label: '聊天提示文案', description: '聊天输入框 placeholder 文案' },
  chat_welcome_message: { value: '你好！有什么可以帮助你的吗？', type: 'string', label: '聊天欢迎消息', description: '聊天页空状态欢迎文案' },
  chat_billing_hint: { value: '⚡ 按实际Token消耗计费：输入 {input}积分/1K tokens，输出 {output}积分/1K tokens', type: 'string', label: '计费提示文案', description: '聊天页面底部显示的计费说明' },
  home_show_onboarding: { value: 'true', type: 'boolean', label: '显示新手引导', description: '首页显示六步引导模块' },
  home_show_featured_modules: { value: 'true', type: 'boolean', label: '显示精选模块', description: '首页显示精选推荐模块' },
  enable_smart_routing: { value: 'true', type: 'boolean', label: '启用智能路由', description: '根据用户问题自动分类任务类型并推荐最合适的AI模型' },
  smart_routing_min_confidence: { value: '0.72', type: 'number', label: '智能路由最小置信度', description: '轻任务命中该阈值后才允许走辅助模型' },
  primary_model_id: { value: '', type: 'string', label: '主力模型 ID', description: '复杂推理、写作、代码等任务的默认主力模型记录 ID' },
  assistant_model_id: { value: '', type: 'string', label: '辅助模型 ID', description: '轻任务、压缩、搜索摘要等任务的默认辅助模型记录 ID' },
  enable_smart_search_decision: { value: 'true', type: 'boolean', label: '启用智能搜索判断', description: '根据请求自动决策是否联网，并优先调用 provider 原生联网能力' },
  search_decision_min_confidence: { value: '0.75', type: 'number', label: '联网决策最小置信度', description: '低于该阈值时即使命中实时性信号也不自动联网' },
  search_surcharge_credits: { value: '0', type: 'number', label: '联网附加积分', description: '每次真实联网搜索额外增加的站内积分成本' },
  enable_prompt_cache: { value: 'false', type: 'boolean', label: 'Prompt Cache（官方 Anthropic 已退役）', description: 'Claude 当前统一经 OpenRouter 调用；该项仅作为历史兼容设置保留，不再作为运行时依赖' },

  // Checkin (6项)
  checkin_day1: { value: '5', type: 'number', label: '签到第1天', description: '第1天签到奖励积分' },
  checkin_day2: { value: '10', type: 'number', label: '签到第2天', description: '第2天签到奖励积分' },
  checkin_day3: { value: '15', type: 'number', label: '签到第3天', description: '第3天签到奖励积分' },
  checkin_day4: { value: '20', type: 'number', label: '签到第4天', description: '第4天签到奖励积分' },
  checkin_day5: { value: '25', type: 'number', label: '签到第5天', description: '第5天签到奖励积分（之后重置）' },
  checkin_monthly_bonus: { value: '50', type: 'number', label: '月度全勤奖', description: '当月签到满30天额外奖励' },

  // Referral / Invite (10项)
  invite_inviter_reward: { value: '50', type: 'number', label: '邀请人奖励', description: '成功邀请1人注册，邀请人获得的积分' },
  invite_invitee_reward: { value: '30', type: 'number', label: '被邀请人奖励', description: '被邀请人注册额外获得的积分' },
  invite_rebate_percent: { value: '5', type: 'number', label: '消费返利比例%', description: '被邀请人30天内消费，邀请人获得的返利比例' },
  invite_binding_days: { value: '30', type: 'number', label: '双向绑定期(天)', description: '被邀请人消费返利的有效期' },
  invite_daily_reward_limit: { value: '1000', type: 'number', label: '每日奖励上限', description: '单用户每日邀请奖励积分上限' },
  invite_monthly_count_limit: { value: '50', type: 'number', label: '每月邀请上限', description: '单用户每月有效邀请人数上限' },
  invite_total_reward_limit: { value: '50000', type: 'number', label: '总奖励封顶', description: '单用户邀请奖励总积分上限' },
  invite_same_ip_hour_limit: { value: '3', type: 'number', label: '同IP小时限制', description: '同一IP每小时最多注册账号数' },
  invite_same_ip_day_limit: { value: '5', type: 'number', label: '同IP日限制', description: '同一IP每天最多注册账号数' },
  invite_risk_auto_reject: { value: 'true', type: 'boolean', label: '高风险自动拒绝', description: '高风险邀请自动拒绝发放奖励' },
};

// 设置分组
const settingGroups = {
  general: ['site_name', 'support_email', 'maintenance_mode'],
  billing: ['new_user_credits', 'billing_credits_per_usd', 'billing_token_price_multiplier', 'billing_min_pre_deduct', 'billing_max_pre_deduct', 'billing_safety_margin', 'billing_require_model_pricing'],
  checkin: ['checkin_day1', 'checkin_day2', 'checkin_day3', 'checkin_day4', 'checkin_day5', 'checkin_monthly_bonus'],
  referral: ['invite_inviter_reward', 'invite_invitee_reward', 'invite_rebate_percent', 'invite_binding_days', 'invite_daily_reward_limit', 'invite_monthly_count_limit', 'invite_total_reward_limit', 'invite_same_ip_hour_limit', 'invite_same_ip_day_limit', 'invite_risk_auto_reject'],
  experience: ['chat_show_model_selector', 'chat_prompt_text', 'chat_welcome_message', 'chat_billing_hint', 'home_show_onboarding', 'home_show_featured_modules'],
  features: ['enable_smart_routing', 'smart_routing_min_confidence', 'primary_model_id', 'assistant_model_id', 'enable_smart_search_decision', 'search_decision_min_confidence', 'search_surcharge_credits', 'enable_prompt_cache', 'enable_free_tier', 'free_tier_messages', 'max_messages_per_conversation', 'max_input_characters', 'enable_long_text_warning', 'long_text_warning_threshold', 'show_token_usage_stats'],
};

interface SettingData {
  value: string;
  type: 'string' | 'number' | 'boolean';
  label: string;
  description: string;
  id?: string;
}

interface MembershipPlan {
  id: string;
  name: string;
  level: 'free' | 'pro' | 'gold';
  history_retention_days: number;
  allow_export: string;
  allow_batch_export: string;
}

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Record<string, SettingData>>({});
  const [saving, setSaving] = useState(false);
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState('');
  const [membershipSettings, setMembershipSettings] = useState<Record<string, { historyRetentionDays: number; allowExport: boolean; allowBatchExport: boolean }>>({});

  const { data: dashboard, isLoading, refetch: refetchDashboard } = trpc.admin.getSettingsDashboard.useQuery();
  const {
    data: cleanupStats,
    isLoading: cleanupStatsLoading,
    refetch: refetchCleanupStats,
  } = trpc.admin.getCleanupStats.useQuery();
  const savedSettings = dashboard?.systemSettings;
  const membershipPlans = dashboard?.membershipPlans;

  const updateSettingsBulk = trpc.settings.updateSystemSettingsBulk.useMutation();

  const updateMembershipPlan = trpc.admin.updateMembershipPlan.useMutation({
    onSuccess: () => {
      refetchDashboard();
      toast.success('会员权限更新成功');
    },
    onError: () => {
      toast.error('更新失败');
    },
  });

  const cleanupConversations = trpc.admin.cleanupExpiredConversations.useMutation({
    onSuccess: (result) => {
      setCleanupMessage(result.message);
      toast.success(result.message);
      void refetchCleanupStats();
    },
    onError: () => {
      setCleanupMessage('清理失败，请稍后重试');
      toast.error('清理失败');
    },
  });

  // Initialize membership settings from plans
  useEffect(() => {
    if (membershipPlans) {
      const newSettings: Record<string, { historyRetentionDays: number; allowExport: boolean; allowBatchExport: boolean }> = {};
      (membershipPlans as MembershipPlan[]).forEach((plan: MembershipPlan) => {
        newSettings[plan.id] = {
          historyRetentionDays: plan.history_retention_days || 30,
          allowExport: plan.allow_export === 'true',
          allowBatchExport: plan.allow_batch_export === 'true',
        };
      });
      setMembershipSettings(newSettings);
    }
  }, [membershipPlans]);

  const handleSaveMembershipSetting = async (planId: string) => {
    const setting = membershipSettings[planId];
    if (!setting) return;

    await updateMembershipPlan.mutateAsync({
      id: planId,
      historyRetentionDays: setting.historyRetentionDays,
      allowExport: setting.allowExport ? 'true' : 'false',
      allowBatchExport: setting.allowBatchExport ? 'true' : 'false',
    });
  };

  const handleCleanup = async () => {
    setCleaningUp(true);
    try {
      await cleanupConversations.mutateAsync();
    } finally {
      setCleaningUp(false);
    }
  };

  // 合并默认设置和已保存的设置
  useEffect(() => {
    const mergedSettings = { ...defaultSettings };
    if (savedSettings) {
      Object.entries(savedSettings).forEach(([key, value]) => {
        if (mergedSettings[key]) {
          mergedSettings[key] = {
            ...mergedSettings[key],
            value: String(value),
          };
        }
      });
    }
    setSettings(mergedSettings);
  }, [savedSettings]);

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      await updateSettingsBulk.mutateAsync(
        Object.entries(settings).map(([key, data]) => ({
          key,
          value: data.value,
        })),
      );
      toast.success('设置保存成功');
      void refetchDashboard();
    } catch {
      toast.error('保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSettingChange = (key: string, value: string) => {
    setSettings(prev => ({
      ...prev,
      [key]: { ...prev[key], value }
    }));
  };

  const renderSettingInput = (key: string, data: SettingData) => {
    if (data.type === 'boolean') {
      return (
        <Switch
          data-testid={`admin-setting-${key}`}
          checked={data.value === 'true'}
          onCheckedChange={(checked) => handleSettingChange(key, checked.toString())}
          className="self-start md:self-center"
        />
      );
    }
    if (data.type === 'number') {
      return (
        <Input
          data-testid={`admin-setting-${key}`}
          type="number"
          value={data.value}
          onChange={(e) => handleSettingChange(key, e.target.value)}
          className="w-full max-w-full sm:max-w-[160px] bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
        />
      );
    }
    return (
      <Input
        data-testid={`admin-setting-${key}`}
        value={data.value}
        onChange={(e) => handleSettingChange(key, e.target.value)}
        className="w-full max-w-full md:max-w-md bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
      />
    );
  };

  const renderSettingGroup = (keys: string[]) => {
    return keys.map(key => {
      const data = settings[key];
      if (!data) return null;
      return (
        <div
          key={key}
          className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between"
          style={{ borderBottom: '1px solid var(--border-primary)' }}
        >
          <div className="flex-1 md:pr-4">
            <Label className="text-base" style={{ color: 'var(--text-primary)' }}>
              {data.label}
            </Label>
            <p className="text-sm mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {data.description}
            </p>
          </div>
          {renderSettingInput(key, data)}
        </div>
      );
    });
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-primary)]"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-8">
      {/* Page Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl" style={{ color: 'var(--text-primary)' }}>
            系统设置
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理平台全局配置
          </p>
        </div>
        <Button
          data-testid="admin-settings-save-all"
          onClick={handleSaveAll}
          disabled={saving}
          className="w-full gap-2 bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 sm:w-auto"
        >
          {saving ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {saving ? '保存中...' : '保存所有设置'}
        </Button>
      </div>

      {/* Settings Tabs */}
      <Tabs defaultValue="general" className="space-y-6">
        <TabsList
          className="flex h-auto w-full justify-start gap-1 overflow-x-auto p-1"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <TabsTrigger value="general" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <Settings className="h-4 w-4" />
            基础设置
          </TabsTrigger>
          <TabsTrigger value="billing" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <CreditCard className="h-4 w-4" />
            积分计费
          </TabsTrigger>
          <TabsTrigger value="checkin" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <Gift className="h-4 w-4" />
            签到福利
          </TabsTrigger>
          <TabsTrigger value="referral" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <Users className="h-4 w-4" />
            邀请奖励
          </TabsTrigger>
          <TabsTrigger value="experience" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <MessageSquare className="h-4 w-4" />
            页面体验
          </TabsTrigger>
          <TabsTrigger value="features" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <Sliders className="h-4 w-4" />
            功能设置
          </TabsTrigger>
          <TabsTrigger value="membership" className="shrink-0 gap-2 data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black">
            <Crown className="h-4 w-4" />
            会员权限
          </TabsTrigger>
        </TabsList>

        {/* General Tab */}
        <TabsContent value="general">
          <Card data-testid="admin-settings-general-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>基础设置</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>平台基本配置</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {renderSettingGroup(settingGroups.general)}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Billing Tab */}
        <TabsContent value="billing">
          <Card data-testid="admin-settings-billing-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>积分计费设置</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                新用户赠送积分与历史兼容计费配置
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Warning about per-token pricing */}
              <div
                className="p-4 rounded-lg mb-4"
                style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)' }}
              >
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium" style={{ color: 'var(--warning)' }}>
                      Token 计费规则已迁移至模型管理
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--warning)', opacity: 0.8 }}>
                      每个 AI 模型的输入/输出 Token 成本在「AI 模型管理」页面单独配置。
                      下方的 Token 积分单价设置仅作为参考显示，实际计费以模型配置为准。
                    </p>
                    <a
                      href="/admin/models"
                      className="text-xs mt-2 inline-block underline hover:no-underline"
                      style={{ color: 'var(--color-primary)' }}
                    >
                      前往 AI 模型管理 →
                    </a>
                  </div>
                </div>
              </div>

              {/* Active settings */}
              <div className="mb-6" data-testid="admin-settings-billing-active-section">
                <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--text-secondary)' }}>
                  有效设置
                </h4>
                {renderSettingGroup(['new_user_credits'])}
              </div>

              {/* Deprecated settings with visual distinction */}
              <div className="opacity-60" data-testid="admin-settings-billing-reference-section">
                <h4 className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-tertiary)' }}>
                  <span>已退役 / 参考显示（不作为生产计费真相）</span>
                  <Badge variant="outline" className="text-xs" style={{ borderColor: 'var(--border-primary)', color: 'var(--text-disabled)' }}>
                    retired-reference
                  </Badge>
                </h4>
                <p className="text-xs mb-3" style={{ color: 'var(--text-disabled)' }}>
                  以下字段仍保留在后台，目的是兼容历史数据和帮助排查旧口径；当前运行时不会消费它们。
                </p>
                {renderSettingGroup(['input_credits_per_1k', 'output_credits_per_1k', 'web_search_credits', 'first_purchase_bonus_percent'])}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Checkin Tab */}
        <TabsContent value="checkin">
          <Card data-testid="admin-settings-checkin-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>签到系统</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                配置每日签到奖励（5天一循环）
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {renderSettingGroup(settingGroups.checkin)}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Referral Tab */}
        <TabsContent value="referral">
          <Card data-testid="admin-settings-referral-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>邀请奖励设置</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                配置邀请注册奖励、消费返利和防刷限制
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div
                className="p-4 rounded-lg mb-4"
                style={{ background: 'var(--success-bg)', border: '1px solid var(--success)' }}
              >
                <p className="text-sm" style={{ color: 'var(--success)' }}>
                  <strong>邀请规则：</strong>用户通过邀请码邀请好友注册，双方都能获得积分奖励
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--success)', opacity: 0.8 }}>
                  被邀请人在绑定期内的消费，邀请人可获得一定比例返利
                </p>
              </div>
              {renderSettingGroup(settingGroups.referral)}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Experience Tab */}
        <TabsContent value="experience">
          <Card data-testid="admin-settings-experience-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>页面体验设置</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                统一管理聊天页和首页的展示文案与模块开关
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {renderSettingGroup(settingGroups.experience)}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Features Tab */}
        <TabsContent value="features">
          <Card data-testid="admin-settings-features-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardHeader>
              <CardTitle style={{ color: 'var(--text-primary)' }}>功能设置</CardTitle>
              <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                启用或禁用平台功能
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {renderSettingGroup(settingGroups.features)}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Membership Tab */}
        <TabsContent value="membership">
          <div className="space-y-6">
            {/* Membership Plans Permissions */}
            <Card data-testid="admin-settings-membership-section" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Crown className="h-5 w-5 text-amber-500" />
                  会员等级权限配置
                </CardTitle>
                <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                  配置不同会员等级的对话历史保存时间和导出权限
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="mb-4 rounded-lg border p-4"
                  style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-primary)' }}
                >
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    套餐价格、积分发放和 Stripe Price ID 在
                    <a href="/admin/packages" className="ml-1 underline hover:no-underline" style={{ color: 'var(--color-primary)' }}>
                      套餐管理
                    </a>
                    维护；这里仅负责会员历史保留、导出权限和批量导出策略。运营调整价格或上下架时，请返回套餐管理页面，不要在本页寻找计费入口。
                  </p>
                </div>
                {!membershipPlans || (membershipPlans as MembershipPlan[]).length === 0 ? (
                  <div
                    className="p-6 rounded-lg text-center"
                    style={{ background: 'var(--bg-tertiary)', border: '1px dashed var(--border-primary)' }}
                  >
                    <Crown className="h-12 w-12 mx-auto mb-4 text-amber-500 opacity-50" />
                    <p style={{ color: 'var(--text-secondary)' }}>
                      暂无会员套餐，请先在「积分包管理」中创建会员套餐
                    </p>
                  </div>
                ) : (
                  <div className="space-y-6">
                    {(membershipPlans as MembershipPlan[]).map((plan: MembershipPlan) => {
                      const setting = membershipSettings[plan.id] || { historyRetentionDays: 30, allowExport: false, allowBatchExport: false };
                      const levelColors: Record<string, string> = {
                        free: 'bg-gray-500/20 text-gray-400',
                        pro: 'bg-blue-500/20 text-blue-400',
                        gold: 'bg-amber-500/20 text-amber-400',
                      };
                      return (
                        <div
                          key={plan.id}
                          data-testid={`membership-plan-${plan.level}`}
                          className="p-4 rounded-lg"
                          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}
                        >
                          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div className="flex items-center gap-3">
                              <Badge className={levelColors[plan.level] || 'bg-gray-500/20 text-gray-400'}>
                                {plan.level.toUpperCase()}
                              </Badge>
                              <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {plan.name}
                              </span>
                            </div>
                            <Button
                              data-testid={`membership-plan-save-${plan.level}`}
                              size="sm"
                              onClick={() => handleSaveMembershipSetting(plan.id)}
                              disabled={updateMembershipPlan.isPending}
                              className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90 md:w-auto"
                            >
                              <Save className="h-3 w-3 mr-1" />
                              保存
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                              <Label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                                <Clock className="h-4 w-4 inline mr-1" />
                                对话历史保存天数
                              </Label>
                              <Input
                                data-testid={`membership-plan-history-${plan.level}`}
                                type="number"
                                min={1}
                                max={365}
                                value={setting.historyRetentionDays}
                                onChange={(e) => {
                                  setMembershipSettings(prev => ({
                                    ...prev,
                                    [plan.id]: { ...prev[plan.id], historyRetentionDays: parseInt(e.target.value) || 30 }
                                  }));
                                }}
                                className="mt-1 bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                              />
                              <p className="text-xs mt-1" style={{ color: 'var(--text-disabled)' }}>
                                超过此天数的对话将被自动清理
                              </p>
                            </div>
                            <div>
                              <Label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                                <Download className="h-4 w-4 inline mr-1" />
                                允许导出对话
                              </Label>
                              <div className="flex items-center gap-2 mt-2">
                                <Switch
                                  data-testid={`membership-plan-allow-export-${plan.level}`}
                                  checked={setting.allowExport}
                                  onCheckedChange={(checked) => {
                                    setMembershipSettings(prev => ({
                                      ...prev,
                                      [plan.id]: { ...prev[plan.id], allowExport: checked }
                                    }));
                                  }}
                                />
                                <span className="text-sm" style={{ color: setting.allowExport ? 'var(--success)' : 'var(--text-disabled)' }}>
                                  {setting.allowExport ? '已启用' : '已禁用'}
                                </span>
                              </div>
                            </div>
                            <div>
                              <Label className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                                <Download className="h-4 w-4 inline mr-1" />
                                允许批量导出
                              </Label>
                              <div className="flex items-center gap-2 mt-2">
                                <Switch
                                  data-testid={`membership-plan-allow-batch-export-${plan.level}`}
                                  checked={setting.allowBatchExport}
                                  onCheckedChange={(checked) => {
                                    setMembershipSettings(prev => ({
                                      ...prev,
                                      [plan.id]: { ...prev[plan.id], allowBatchExport: checked }
                                    }));
                                  }}
                                />
                                <span className="text-sm" style={{ color: setting.allowBatchExport ? 'var(--success)' : 'var(--text-disabled)' }}>
                                  {setting.allowBatchExport ? '已启用' : '已禁用'}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Cleanup Section */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Trash2 className="h-5 w-5 text-red-400" />
                  对话历史清理
                </CardTitle>
                <CardDescription style={{ color: 'var(--text-tertiary)' }}>
                  手动清理超过保存期限的对话历史记录
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div
                  className="p-4 rounded-lg mb-4"
                  style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning)' }}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-400 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--warning)' }}>
                        清理操作不可恢复
                      </p>
                      <p className="text-xs mt-1" style={{ color: 'var(--warning)', opacity: 0.8 }}>
                        此操作将根据各会员等级设置的保存天数，删除所有用户超期的对话及其消息记录
                      </p>
                    </div>
                  </div>
                </div>

                {/* Stats */}
                {cleanupStats && (
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                    {cleanupStats.stats.map((stat) => (
                      <div
                        key={stat.level}
                        className="p-3 rounded-lg"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <Badge className={
                            stat.level === 'free' ? 'bg-gray-500/20 text-gray-400' :
                            stat.level === 'pro' ? 'bg-blue-500/20 text-blue-400' :
                            'bg-amber-500/20 text-amber-400'
                          }>
                            {stat.level.toUpperCase()}
                          </Badge>
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            {stat.retentionDays}天
                          </span>
                        </div>
                        <p className="text-lg font-bold" style={{ color: stat.expiredCount > 0 ? 'var(--warning)' : 'var(--text-primary)' }}>
                          {stat.expiredCount} 个过期
                        </p>
                      </div>
                    ))}
                    <div
                      className="p-3 rounded-lg border-2"
                      style={{ background: 'var(--bg-tertiary)', borderColor: cleanupStats.totalExpired > 0 ? 'var(--warning)' : 'var(--border-primary)' }}
                    >
                      <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>待清理总数</p>
                      <p className="text-2xl font-bold" style={{ color: cleanupStats.totalExpired > 0 ? 'var(--warning)' : 'var(--success)' }}>
                        {cleanupStats.totalExpired}
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-4">
                  <Button
                    variant="destructive"
                    data-testid="admin-settings-cleanup-trigger"
                    onClick={handleCleanup}
                    disabled={cleaningUp || cleanupStatsLoading || (cleanupStats?.totalExpired === 0)}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    {cleaningUp ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 mr-2" />
                    )}
                    {cleaningUp ? '清理中...' : '执行清理'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void refetchCleanupStats()}
                    className="border-[var(--border-primary)] text-[var(--text-secondary)]"
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    刷新统计
                  </Button>
                  {cleanupStatsLoading && (
                    <div className="flex items-center gap-2 text-[var(--text-tertiary)]">
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span className="text-sm">正在加载清理统计...</span>
                    </div>
                  )}
                  {cleanupStats?.totalExpired === 0 && (
                    <div className="flex items-center gap-2 text-emerald-400">
                      <CheckCircle className="h-4 w-4" />
                      <span className="text-sm">暂无需要清理的对话</span>
                    </div>
                  )}
                </div>
                <div className="mt-3 text-sm" data-testid="admin-settings-cleanup-status" style={{ color: 'var(--text-secondary)' }}>
                  {cleanupMessage || '尚未执行清理'}
                </div>
                {cleanupStats?.latestRun && (
                  <div
                    className="mt-2 rounded-lg border px-3 py-3 text-sm"
                    style={{ background: 'var(--bg-primary)', borderColor: 'rgba(255,255,255,0.08)' }}
                  >
                    <div className="flex flex-wrap items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                      <span>最近自动清理：</span>
                      <Badge className={cleanupStats.latestRun.status === 'success' ? 'bg-emerald-500/20 text-emerald-400' : cleanupStats.latestRun.status === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}>
                        {cleanupStats.latestRun.status === 'success' ? '成功' : cleanupStats.latestRun.status === 'error' ? '失败' : '执行中'}
                      </Badge>
                      <span style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(cleanupStats.latestRun.started_at).toLocaleString('zh-CN')}
                      </span>
                    </div>
                    {cleanupStats.latestRun.summary?.deletedCount != null && (
                      <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        自动清理删除了 {cleanupStats.latestRun.summary.deletedCount} 个对话记录
                      </div>
                    )}
                    {cleanupStats.latestRun.error && (
                      <div className="mt-1 text-red-400">
                        {getSafeErrorMessage(cleanupStats.latestRun.error, '自动清理失败，请稍后重试。')}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
