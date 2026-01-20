'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Megaphone, Plus, Pencil, Trash2, Check, X,
  Info, AlertTriangle, CheckCircle, XCircle,
  Calendar, RefreshCw
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
import AdminSidebar from '@/components/admin/AdminSidebar';

type AnnouncementType = 'info' | 'warning' | 'success' | 'error';

interface Announcement {
  id: string;
  title: string;
  content: string;
  type: AnnouncementType;
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
};

export default function AdminAnnouncementsPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<Announcement | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    type: 'info' as AnnouncementType,
    priority: '0',
    startDate: '',
    endDate: '',
  });

  const { data, isLoading, error, refetch } = trpc.admin.getAllAnnouncements.useQuery({
    limit: 50,
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

  const openCreateDialog = () => {
    setEditingAnnouncement(null);
    setFormData({
      title: '',
      content: '',
      type: 'info',
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
      priority: announcement.priority.toString(),
      startDate: announcement.start_date ? new Date(announcement.start_date).toISOString().slice(0, 16) : '',
      endDate: announcement.end_date ? new Date(announcement.end_date).toISOString().slice(0, 16) : '',
    });
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingAnnouncement(null);
    setFormData({
      title: '',
      content: '',
      type: 'info',
      priority: '0',
      startDate: '',
      endDate: '',
    });
  };

  const handleSubmit = () => {
    const priority = parseInt(formData.priority) || 0;

    if (editingAnnouncement) {
      updateAnnouncement.mutate({
        id: editingAnnouncement.id,
        title: formData.title,
        content: formData.content,
        type: formData.type,
        priority,
        startDate: formData.startDate ? new Date(formData.startDate).toISOString() : undefined,
        endDate: formData.endDate ? new Date(formData.endDate).toISOString() : null,
      });
    } else {
      createAnnouncement.mutate({
        title: formData.title,
        content: formData.content,
        type: formData.type,
        priority,
        startDate: formData.startDate ? new Date(formData.startDate).toISOString() : undefined,
        endDate: formData.endDate ? new Date(formData.endDate).toISOString() : undefined,
      });
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

  const announcements = data?.announcements ?? [];
  const stats = data?.stats ?? { total: 0, active: 0, inactive: 0, byType: { info: 0, warning: 0, success: 0, error: 0 } };

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              公告管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              发布和管理系统公告
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refetch()}
              className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              刷新
            </Button>
            <Button
              onClick={openCreateDialog}
              className="bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
            >
              <Plus className="h-4 w-4 mr-2" />
              发布公告
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-[var(--color-primary-20)]">
                  <Megaphone className="h-6 w-6 text-[var(--color-primary)]" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>总公告数</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.total}
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
                    {stats.active}
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
                    {stats.inactive}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-xl bg-amber-500/20">
                  <AlertTriangle className="h-6 w-6 text-amber-400" />
                </div>
                <div>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>警告公告</p>
                  <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                    {stats.byType.warning}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Announcements Table */}
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>标题</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>有效期</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[120px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.map((announcement: Announcement) => {
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
                        <span style={{ color: 'var(--text-primary)' }}>
                          {announcement.priority}
                        </span>
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
                        <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                          <Calendar className="h-3 w-3" />
                          <span>
                            {announcement.start_date
                              ? new Date(announcement.start_date).toLocaleDateString('zh-CN')
                              : '立即'}
                            {' - '}
                            {announcement.end_date
                              ? new Date(announcement.end_date).toLocaleDateString('zh-CN')
                              : '永久'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(announcement.created_at).toLocaleDateString('zh-CN')}
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
                {announcements.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无公告，点击上方按钮发布
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
            className="max-w-lg"
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
          >
            <DialogHeader>
              <DialogTitle style={{ color: 'var(--text-primary)' }}>
                {editingAnnouncement ? '编辑公告' : '发布公告'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>标题</Label>
                <Input
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="如：系统维护通知"
                  className="bg-[var(--bg-tertiary)] border-[var(--border-primary)] text-[var(--text-primary)]"
                />
              </div>

              <div className="space-y-2">
                <Label style={{ color: 'var(--text-secondary)' }}>内容</Label>
                <Textarea
                  value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  placeholder="公告详细内容..."
                  rows={4}
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
                    <SelectContent>
                      <SelectItem value="info">
                        <div className="flex items-center gap-2">
                          <Info className="h-4 w-4 text-blue-400" />
                          信息
                        </div>
                      </SelectItem>
                      <SelectItem value="warning">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-amber-400" />
                          警告
                        </div>
                      </SelectItem>
                      <SelectItem value="success">
                        <div className="flex items-center gap-2">
                          <CheckCircle className="h-4 w-4 text-emerald-400" />
                          成功
                        </div>
                      </SelectItem>
                      <SelectItem value="error">
                        <div className="flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-rose-400" />
                          错误
                        </div>
                      </SelectItem>
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
    </div>
  );
}
