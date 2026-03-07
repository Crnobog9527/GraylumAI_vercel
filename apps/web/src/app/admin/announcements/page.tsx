'use client';

import { useState, useEffect } from 'react';
import { trpc } from '@/trpc/client';
import {
  Megaphone, Plus, Pencil, Trash2, Check, X,
  Info, AlertTriangle, CheckCircle, XCircle,
  Calendar, RefreshCw, Globe, Home, MessageSquare,
  Link2, Palette, Tag, ArrowUpDown, Settings, Sparkles
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type AnnouncementType = 'info' | 'warning' | 'success' | 'error' | 'promo' | 'announcement';
type AnnouncementAreaType = 'homepage' | 'banner';
type BannerStyle = 'info' | 'warning' | 'success' | 'error' | 'promo' | 'announcement';

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
  announcement_type: AnnouncementAreaType;
  banner_style: BannerStyle | null;
  banner_link: string | null;
  icon: string | null;
  icon_color: string | null;
  tag: string | null;
  tag_color: string | null;
  priority: number;
  active: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

const typeConfig: Record<AnnouncementType, { label: string; color: string; icon: React.ElementType }> = {
  info: { label: '信息', color: 'bg-blue-500/20 text-blue-400', icon: Info },
  warning: { label: '警告', color: 'bg-amber-500/20 text-amber-400', icon: AlertTriangle },
  success: { label: '成功', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
  error: { label: '错误', color: 'bg-rose-500/20 text-rose-400', icon: XCircle },
  promo: { label: '促销', color: 'bg-purple-500/20 text-purple-400', icon: Sparkles },
  announcement: { label: '公告', color: 'bg-[var(--color-primary-20)] text-[var(--color-primary)]', icon: Megaphone },
};

const bannerStyleConfig: Record<BannerStyle, { label: string; color: string }> = {
  info: { label: '信息蓝', color: 'bg-blue-500' },
  warning: { label: '警告橙', color: 'bg-amber-500' },
  success: { label: '成功绿', color: 'bg-emerald-500' },
  error: { label: '错误红', color: 'bg-rose-500' },
  promo: { label: '促销紫', color: 'bg-purple-500' },
  announcement: { label: '公告黄', color: 'bg-[var(--color-primary)]' },
};

const iconOptions = [
  'Megaphone', 'Bell', 'Info', 'AlertTriangle', 'CheckCircle', 'XCircle',
  'Star', 'Gift', 'Zap', 'Sparkles', 'Heart', 'Crown', 'Trophy', 'Rocket'
];

const tagColorOptions = [
  { value: 'blue', label: '蓝色', class: 'bg-blue-500' },
  { value: 'green', label: '绿色', class: 'bg-emerald-500' },
  { value: 'yellow', label: '黄色', class: 'bg-amber-500' },
  { value: 'red', label: '红色', class: 'bg-rose-500' },
  { value: 'purple', label: '紫色', class: 'bg-purple-500' },
  { value: 'pink', label: '粉色', class: 'bg-pink-500' },
];

export default function AdminAnnouncementsPage() {
  const [activeTab, setActiveTab] = useState<'banner' | 'homepage' | 'settings'>('banner');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<Announcement | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    type: 'info' as AnnouncementType,
    announcementType: 'banner' as AnnouncementAreaType,
    bannerStyle: 'info' as BannerStyle,
    bannerLink: '',
    icon: 'Megaphone',
    iconColor: 'text-blue-500',
    tag: '',
    tagColor: 'blue',
    priority: '0',
    startDate: '',
    endDate: '',
  });

  // Chat page settings state
  const [chatSettings, setChatSettings] = useState({
    showModelSelector: true,
    chatPromptText: '请选择一个模型开始对话',
    welcomeMessage: '你好！有什么可以帮助你的吗？',
  });

  // Homepage guide settings state
  const [homeGuideSettings, setHomeGuideSettings] = useState({
    showOnboarding: true,
    showFeaturedModules: true,
  });

  // Fetch system settings to initialize values
  const { data: systemSettings } = trpc.settings.getSystemSettings.useQuery();

  // Update system settings mutation
  const updateSetting = trpc.settings.updateSystemSettings.useMutation();

  // Initialize settings from database
  useEffect(() => {
    if (systemSettings) {
      setChatSettings({
        showModelSelector: systemSettings.chat_show_model_selector === true || systemSettings.chat_show_model_selector === 'true',
        chatPromptText: (systemSettings.chat_prompt_text as string) || '请选择一个模型开始对话',
        welcomeMessage: (systemSettings.chat_welcome_message as string) || '你好！有什么可以帮助你的吗？',
      });
      setHomeGuideSettings({
        showOnboarding: systemSettings.home_show_onboarding === true || systemSettings.home_show_onboarding === 'true',
        showFeaturedModules: systemSettings.home_show_featured_modules === true || systemSettings.home_show_featured_modules === 'true',
      });
    }
  }, [systemSettings]);

  // Save chat page settings
  const handleSaveChatSettings = async () => {
    try {
      await Promise.all([
        updateSetting.mutateAsync({ key: 'chat_show_model_selector', value: chatSettings.showModelSelector }),
        updateSetting.mutateAsync({ key: 'chat_prompt_text', value: chatSettings.chatPromptText }),
        updateSetting.mutateAsync({ key: 'chat_welcome_message', value: chatSettings.welcomeMessage }),
      ]);
      alert('聊天页面设置保存成功！');
    } catch {
      alert('保存失败，请重试');
    }
  };

  // Save homepage guide settings
  const handleSaveHomeGuideSettings = async () => {
    try {
      await Promise.all([
        updateSetting.mutateAsync({ key: 'home_show_onboarding', value: homeGuideSettings.showOnboarding }),
        updateSetting.mutateAsync({ key: 'home_show_featured_modules', value: homeGuideSettings.showFeaturedModules }),
      ]);
      alert('首页引导设置保存成功！');
    } catch {
      alert('保存失败，请重试');
    }
  };

  const { data, isLoading, error, refetch } = trpc.admin.getAllAnnouncements.useQuery({
    limit: 100,
  });

  const createAnnouncement = trpc.admin.createAnnouncement.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const updateAnnouncement = trpc.admin.updateAnnouncement.useMutation({
    onSuccess: () => {
      refetch();
      closeDialog();
    }
  });

  const deleteAnnouncement = trpc.admin.deleteAnnouncement.useMutation({
    onSuccess: () => {
      refetch();
    }
  });

  const openCreateDialog = (type: AnnouncementAreaType) => {
    setEditingAnnouncement(null);
    setFormData({
      title: '',
      content: '',
      type: 'info',
      announcementType: type,
      bannerStyle: 'info',
      bannerLink: '',
      icon: 'Megaphone',
      iconColor: 'text-blue-500',
      tag: '',
      tagColor: 'blue',
      priority: '0',
      startDate: new Date().toISOString().slice(0, 16),
      endDate: '',
    });
    setDialogOpen(true);
  };

  const openEditDialog = (announcement: Announcement) => {
    setEditingAnnouncement(announcement);
    setFormData({
      title: announcement.title,
      content: announcement.content,
      type: announcement.type,
      announcementType: announcement.announcement_type,
      bannerStyle: (announcement.banner_style || 'info') as BannerStyle,
      bannerLink: announcement.banner_link || '',
      icon: announcement.icon || 'Megaphone',
      iconColor: announcement.icon_color || 'text-blue-500',
      tag: announcement.tag || '',
      tagColor: announcement.tag_color || 'blue',
      priority: announcement.priority.toString(),
      startDate: announcement.start_date ? new Date(announcement.start_date).toISOString().slice(0, 16) : '',
      endDate: announcement.end_date ? new Date(announcement.end_date).toISOString().slice(0, 16) : '',
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingAnnouncement(null);
  };

  const handleSubmit = () => {
    const priority = parseInt(formData.priority) || 0;

    const payload = {
      title: formData.title,
      content: formData.content,
      type: formData.type,
      announcementType: formData.announcementType,
      bannerStyle: formData.announcementType === 'banner' ? formData.bannerStyle : undefined,
      bannerLink: formData.announcementType === 'banner' && formData.bannerLink ? formData.bannerLink : undefined,
      icon: formData.icon,
      iconColor: formData.iconColor,
      tag: formData.tag || undefined,
      tagColor: formData.tag ? formData.tagColor : undefined,
      priority,
      startDate: formData.startDate ? new Date(formData.startDate).toISOString() : undefined,
      endDate: formData.endDate ? new Date(formData.endDate).toISOString() : undefined,
    };

    if (editingAnnouncement) {
      updateAnnouncement.mutate({
        id: editingAnnouncement.id,
        ...payload,
      });
    } else {
      createAnnouncement.mutate(payload);
    }
  };

  const handleToggleActive = (announcement: Announcement) => {
    updateAnnouncement.mutate({
      id: announcement.id,
      active: announcement.active === 'true' ? 'false' : 'true',
    });
  };

  const handleDelete = (announcement: Announcement) => {
    if (confirm(`确定要删除公告 "${announcement.title}" 吗？`)) {
      deleteAnnouncement.mutate({ id: announcement.id });
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

  const announcements = data?.announcements ?? [];
  const bannerAnnouncements = announcements.filter((a: Announcement) => a.announcement_type === 'banner');
  const homepageAnnouncements = announcements.filter((a: Announcement) => a.announcement_type === 'homepage');

  const stats = {
    totalBanner: bannerAnnouncements.length,
    activeBanner: bannerAnnouncements.filter((a: Announcement) => a.active === 'true').length,
    totalHomepage: homepageAnnouncements.length,
    activeHomepage: homepageAnnouncements.filter((a: Announcement) => a.active === 'true').length,
  };

  const renderAnnouncementTable = (items: Announcement[], areaType: AnnouncementAreaType) => (
    <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
          {areaType === 'banner' ? <Globe className="h-5 w-5" /> : <Home className="h-5 w-5" />}
          {areaType === 'banner' ? '横幅公告' : '首页公告'}
        </CardTitle>
        <Button
          onClick={() => openCreateDialog(areaType)}
          size="sm"
          className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
        >
          <Plus className="h-4 w-4 mr-1" />
          添加
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>标题</TableHead>
              <TableHead>类型</TableHead>
              {areaType === 'banner' && <TableHead>样式</TableHead>}
              <TableHead>标签</TableHead>
              <TableHead>优先级</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="w-[120px]">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((announcement: Announcement) => {
              const config = typeConfig[announcement.type];
              const TypeIcon = config.icon;
              return (
                <TableRow key={announcement.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <div
                        className="p-2 rounded-lg"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <Megaphone className="h-4 w-4 text-[var(--color-primary)]" />
                      </div>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {announcement.title}
                        </p>
                        <p className="text-xs truncate max-w-[200px]" style={{ color: 'var(--text-tertiary)' }}>
                          {announcement.content}
                        </p>
                        {areaType === 'banner' && announcement.banner_link && (
                          <div className="flex items-center gap-1 mt-1">
                            <Link2 className="h-3 w-3 text-blue-400" />
                            <span className="text-xs text-blue-400 truncate max-w-[150px]">
                              {announcement.banner_link}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge className={config.color}>
                      <TypeIcon className="h-3 w-3 mr-1" />
                      {config.label}
                    </Badge>
                  </TableCell>
                  {areaType === 'banner' && (
                    <TableCell>
                      {announcement.banner_style && (
                        <div className="flex items-center gap-2">
                          <div className={`w-3 h-3 rounded ${bannerStyleConfig[announcement.banner_style as BannerStyle]?.color || 'bg-gray-400'}`} />
                          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {bannerStyleConfig[announcement.banner_style as BannerStyle]?.label || announcement.banner_style}
                          </span>
                        </div>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {announcement.tag ? (
                      <Badge className={`bg-${announcement.tag_color || 'blue'}-500/20 text-${announcement.tag_color || 'blue'}-400`}>
                        {announcement.tag}
                      </Badge>
                    ) : (
                      <span style={{ color: 'var(--text-disabled)' }}>-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <ArrowUpDown className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />
                      <span style={{ color: 'var(--text-primary)' }}>
                        {announcement.priority}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={announcement.active === 'true'
                        ? 'bg-emerald-500/20 text-emerald-400 cursor-pointer'
                        : 'bg-rose-500/20 text-rose-400 cursor-pointer'
                      }
                      onClick={() => handleToggleActive(announcement)}
                    >
                      {announcement.active === 'true' ? (
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
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(announcement)}
                        className="h-8 w-8 text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(announcement)}
                        className="h-8 w-8 text-rose-400 hover:bg-rose-500/20"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={areaType === 'banner' ? 7 : 6} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                  暂无{areaType === 'banner' ? '横幅' : '首页'}公告
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );

  return (
    <div className="p-8 overflow-auto">
      {/* Page Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
            公告管理
          </h1>
          <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
            管理横幅公告、首页公告和聊天页面设置
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
              <div className="p-3 rounded-xl bg-blue-500/20">
                <Globe className="h-6 w-6 text-blue-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>横幅公告</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  {stats.totalBanner}
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
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>横幅已启用</p>
                <p className="text-2xl font-bold text-emerald-400">
                  {stats.activeBanner}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-purple-500/20">
                <Home className="h-6 w-6 text-purple-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>首页公告</p>
                <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                  {stats.totalHomepage}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-amber-500/20">
                <Check className="h-6 w-6 text-amber-400" />
              </div>
              <div>
                <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>首页已启用</p>
                <p className="text-2xl font-bold text-amber-400">
                  {stats.activeHomepage}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <TabsList
          className="mb-6"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <TabsTrigger
            value="banner"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Globe className="h-4 w-4 mr-2" />
            横幅公告
          </TabsTrigger>
          <TabsTrigger
            value="homepage"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Home className="h-4 w-4 mr-2" />
            首页公告
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="data-[state=active]:bg-[var(--color-primary)] data-[state=active]:text-black"
          >
            <Settings className="h-4 w-4 mr-2" />
            页面设置
          </TabsTrigger>
        </TabsList>

        <TabsContent value="banner">
          {renderAnnouncementTable(bannerAnnouncements, 'banner')}
        </TabsContent>

        <TabsContent value="homepage">
          {renderAnnouncementTable(homepageAnnouncements, 'homepage')}
        </TabsContent>

        <TabsContent value="settings">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Chat Page Settings */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <MessageSquare className="h-5 w-5" />
                  聊天页面设置
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>显示模型选择器</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>允许用户在聊天页面切换模型</p>
                  </div>
                  <Switch
                    checked={chatSettings.showModelSelector}
                    onCheckedChange={(checked) => setChatSettings({ ...chatSettings, showModelSelector: checked })}
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>聊天提示文案</Label>
                  <Input
                    data-testid="announcement-chat-prompt-input"
                    value={chatSettings.chatPromptText}
                    onChange={(e) => setChatSettings({ ...chatSettings, chatPromptText: e.target.value })}
                    placeholder="请选择一个模型开始对话"
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>欢迎消息</Label>
                  <Textarea
                    data-testid="announcement-chat-welcome-input"
                    value={chatSettings.welcomeMessage}
                    onChange={(e) => setChatSettings({ ...chatSettings, welcomeMessage: e.target.value })}
                    placeholder="你好！有什么可以帮助你的吗？"
                    rows={3}
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>

                <Button
                  data-testid="announcement-save-chat-settings"
                  className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
                  onClick={handleSaveChatSettings}
                  disabled={updateSetting.isPending}
                >
                  {updateSetting.isPending ? '保存中...' : '保存聊天页面设置'}
                </Button>
              </CardContent>
            </Card>

            {/* Homepage Guide Settings */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Home className="h-5 w-5" />
                  首页引导设置
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    首页引导设置可以配置：
                  </p>
                  <ul className="mt-2 space-y-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    <li>• 新手引导步骤和提示</li>
                    <li>• 精选模块展示顺序</li>
                    <li>• 快捷入口配置</li>
                    <li>• 推荐功能卡片</li>
                  </ul>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>显示新手引导</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>新用户首次访问时显示</p>
                  </div>
                  <Switch
                    data-testid="announcement-home-onboarding-switch"
                    checked={homeGuideSettings.showOnboarding}
                    onCheckedChange={(checked) => setHomeGuideSettings({ ...homeGuideSettings, showOnboarding: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                  <div>
                    <p className="font-medium" style={{ color: 'var(--text-primary)' }}>显示精选模块</p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>在首页展示推荐功能模块</p>
                  </div>
                  <Switch
                    data-testid="announcement-home-featured-switch"
                    checked={homeGuideSettings.showFeaturedModules}
                    onCheckedChange={(checked) => setHomeGuideSettings({ ...homeGuideSettings, showFeaturedModules: checked })}
                  />
                </div>

                <Button
                  data-testid="announcement-save-home-settings"
                  className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
                  onClick={handleSaveHomeGuideSettings}
                  disabled={updateSetting.isPending}
                >
                  {updateSetting.isPending ? '保存中...' : '保存首页引导设置'}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="max-w-2xl max-h-[90vh] overflow-y-auto"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: 'var(--text-primary)' }}>
              {editingAnnouncement ? '编辑公告' : `发布${formData.announcementType === 'banner' ? '横幅' : '首页'}公告`}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>标题</Label>
              <Input
                data-testid="announcement-title-input"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="如：系统维护通知"
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>

            <div className="space-y-2">
              <Label style={{ color: 'var(--text-secondary)' }}>内容</Label>
              <Textarea
                data-testid="announcement-content-input"
                value={formData.content}
                onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                placeholder="公告详细内容..."
                rows={3}
                className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>类型</Label>
                <Select
                  value={formData.type}
                  onValueChange={(v) => setFormData({ ...formData, type: v as AnnouncementType })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    {Object.entries(typeConfig).map(([key, config]) => {
                      const TypeIcon = config.icon;
                      return (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <TypeIcon className="h-4 w-4" />
                            {config.label}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>优先级 (0-100)</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                  placeholder="0"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>
            </div>

            {formData.announcementType === 'banner' && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>
                    <div className="flex items-center gap-2">
                      <Palette className="h-4 w-4" />
                      横幅样式
                    </div>
                  </Label>
                  <Select
                    value={formData.bannerStyle}
                    onValueChange={(v) => setFormData({ ...formData, bannerStyle: v as BannerStyle })}
                  >
                    <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      {Object.entries(bannerStyleConfig).map(([key, config]) => (
                        <SelectItem key={key} value={key}>
                          <div className="flex items-center gap-2">
                            <div className={`w-3 h-3 rounded ${config.color}`} />
                            {config.label}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label style={{ color: 'var(--text-secondary)' }}>
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4" />
                      横幅链接 (可选)
                    </div>
                  </Label>
                  <Input
                    value={formData.bannerLink}
                    onChange={(e) => setFormData({ ...formData, bannerLink: e.target.value })}
                    placeholder="https://..."
                    className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>
                  <div className="flex items-center gap-2">
                    <Tag className="h-4 w-4" />
                    标签文字 (可选)
                  </div>
                </Label>
                <Input
                  value={formData.tag}
                  onChange={(e) => setFormData({ ...formData, tag: e.target.value })}
                  placeholder="如：新功能、限时"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>标签颜色</Label>
                <Select
                  value={formData.tagColor}
                  onValueChange={(v) => setFormData({ ...formData, tagColor: v })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    {tagColorOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        <div className="flex items-center gap-2">
                          <div className={`w-3 h-3 rounded ${option.class}`} />
                          {option.label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>图标</Label>
                <Select
                  value={formData.icon}
                  onValueChange={(v) => setFormData({ ...formData, icon: v })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    {iconOptions.map((icon) => (
                      <SelectItem key={icon} value={icon}>
                        {icon}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>图标颜色</Label>
                <Select
                  value={formData.iconColor}
                  onValueChange={(v) => setFormData({ ...formData, iconColor: v })}
                >
                  <SelectTrigger className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                    <SelectItem value="text-blue-500">蓝色</SelectItem>
                    <SelectItem value="text-emerald-500">绿色</SelectItem>
                    <SelectItem value="text-amber-500">黄色</SelectItem>
                    <SelectItem value="text-rose-500">红色</SelectItem>
                    <SelectItem value="text-purple-500">紫色</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>开始时间</Label>
                <Input
                  type="datetime-local"
                  value={formData.startDate}
                  onChange={(e) => setFormData({ ...formData, startDate: e.target.value })}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>结束时间 (可选)</Label>
                <Input
                  type="datetime-local"
                  value={formData.endDate}
                  onChange={(e) => setFormData({ ...formData, endDate: e.target.value })}
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
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
              disabled={!formData.title || !formData.content || createAnnouncement.isPending || updateAnnouncement.isPending}
              className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
            >
              {createAnnouncement.isPending || updateAnnouncement.isPending ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
