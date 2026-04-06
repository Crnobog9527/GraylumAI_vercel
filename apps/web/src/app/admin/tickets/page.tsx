'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Headphones, MessageSquare, Clock, CheckCircle,
  AlertCircle, Send, ChevronRight, User, Shield, Bug,
  Lightbulb, HelpCircle, CreditCard, UserCircle, MoreHorizontal,
  Image, FileText, Download, Copy, CheckCheck, Tag, Flag,
  ArrowUpCircle, ArrowRightCircle
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import AdminLoadingState from '@/components/admin/AdminLoadingState';
import AdminErrorState from '@/components/admin/AdminErrorState';

type TicketStatus = 'open' | 'in_progress' | 'closed';
type TicketCategory = 'bug' | 'feature' | 'question' | 'account' | 'billing' | 'other';
type TicketPriority = 'low' | 'medium' | 'high' | 'urgent';

interface UserProfile {
  id: string;
  email: string | null;
  nickname: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
}

interface TicketReply {
  id: string;
  content: string;
  user_id: string;
  is_admin: string;
  attachments: string[];
  created_at: string;
  user?: UserProfile | null;
}

interface Ticket {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  category: TicketCategory;
  priority: TicketPriority;
  attachments: string[];
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  user?: UserProfile | null;
  ticket_replies: TicketReply[];
}

const isImageAttachment = (url: string) => {
  const urlWithoutParams = url.split('?')[0];
  return /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(urlWithoutParams);
};

function TicketAttachmentTile({ url, index }: { url: string; index: number }) {
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  if (!isImageAttachment(url) || imageLoadFailed) {
    return (
      <div className="aspect-square bg-[var(--bg-tertiary)] flex flex-col items-center justify-center p-2">
        <Image className="h-8 w-8 text-[var(--text-tertiary)]" />
        <span className="text-xs mt-1 text-[var(--text-disabled)] truncate max-w-full">
          {imageLoadFailed ? `附件 ${index + 1}` : '文件'}
        </span>
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={`附件 ${index + 1}`}
      className="w-full h-full object-cover aspect-square"
      onError={() => setImageLoadFailed(true)}
    />
  );
}

const statusConfig: Record<TicketStatus, { label: string; color: string; icon: React.ElementType }> = {
  open: { label: '待处理', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30', icon: AlertCircle },
  in_progress: { label: '处理中', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30', icon: Clock },
  closed: { label: '已关闭', color: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', icon: CheckCircle },
};

const categoryConfig: Record<TicketCategory, { label: string; icon: React.ElementType; color: string }> = {
  bug: { label: 'Bug', icon: Bug, color: 'text-red-400 bg-red-500/10' },
  feature: { label: '功能建议', icon: Lightbulb, color: 'text-purple-400 bg-purple-500/10' },
  question: { label: '咨询', icon: HelpCircle, color: 'text-blue-400 bg-blue-500/10' },
  account: { label: '账户问题', icon: UserCircle, color: 'text-orange-400 bg-orange-500/10' },
  billing: { label: '账单问题', icon: CreditCard, color: 'text-green-400 bg-green-500/10' },
  other: { label: '其他', icon: MoreHorizontal, color: 'text-gray-400 bg-gray-500/10' },
};

const priorityConfig: Record<TicketPriority, { label: string; color: string; icon: React.ElementType }> = {
  low: { label: '低', color: 'text-gray-400 bg-gray-500/10', icon: ArrowRightCircle },
  medium: { label: '中', color: 'text-blue-400 bg-blue-500/10', icon: ArrowRightCircle },
  high: { label: '高', color: 'text-orange-400 bg-orange-500/10', icon: ArrowUpCircle },
  urgent: { label: '紧急', color: 'text-red-400 bg-red-500/10', icon: Flag },
};

export default function AdminTicketsPage() {
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<TicketCategory | 'all'>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = trpc.admin.getAllTickets.useQuery({
    status: statusFilter === 'all' ? undefined : statusFilter,
    category: categoryFilter === 'all' ? undefined : categoryFilter,
  });
  const tickets = (data?.tickets ?? []) as Ticket[];

  const updateStatus = trpc.admin.updateTicketStatus.useMutation({
    onSuccess: async () => {
      const refreshed = await refetch();
      if (selectedTicket) {
        const updated = refreshed.data?.tickets?.find(t => t.id === selectedTicket.id);
        if (updated) setSelectedTicket(updated);
      }
    }
  });

  const replyMutation = trpc.admin.replyToTicket.useMutation({
    onSuccess: async () => {
      const refreshed = await refetch();
      setReplyContent('');
      if (selectedTicket) {
        const updated = refreshed.data?.tickets?.find(t => t.id === selectedTicket.id);
        if (updated) setSelectedTicket(updated);
      }
    }
  });

  const handleStatusChange = (ticketId: string, newStatus: TicketStatus) => {
    updateStatus.mutate({ ticketId, status: newStatus });
  };

  const handleReply = () => {
    if (!selectedTicket || !replyContent.trim()) return;
    replyMutation.mutate({
      ticketId: selectedTicket.id,
      content: replyContent.trim(),
    });
  };

  const handleMarkResolved = () => {
    if (!selectedTicket) return;
    handleStatusChange(selectedTicket.id, 'closed');
  };

  const openTicketDetail = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setSheetOpen(true);
  };

  const copyTicketId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatShortId = (id: string) => {
    return id.slice(0, 8).toUpperCase();
  };

  const getUserDisplayName = (user?: UserProfile | null) => {
    if (!user) return '未知用户';
    return user.nickname || user.email || '未知用户';
  };

  const getAvatarFallback = (user?: UserProfile | null) => {
    if (!user) return '?';
    if (user.nickname) return user.nickname.charAt(0).toUpperCase();
    if (user.email) return user.email.charAt(0).toUpperCase();
    return '?';
  };

  // Loading state
  if (isLoading) {
    return <AdminLoadingState />;
  }

  // Error state
  if (error) {
    return <AdminErrorState error={error} onRetry={() => refetch()} />;
  }

  // Count tickets by status
  const statusCounts = data?.statusCounts ?? {
    all: 0,
    open: 0,
    in_progress: 0,
    closed: 0,
  };

  return (
    <TooltipProvider>
      <div className="p-8 overflow-auto" data-testid="admin-tickets-page">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8" data-testid="admin-tickets-header">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              工单管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              处理用户反馈和支持请求
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Category Filter */}
            <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v as typeof categoryFilter)}>
              <SelectTrigger className="w-[140px] bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                <Tag className="h-4 w-4 mr-2 text-[var(--text-tertiary)]" />
                <SelectValue placeholder="分类筛选" />
              </SelectTrigger>
              <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                <SelectItem value="all">全部分类</SelectItem>
                {Object.entries(categoryConfig).map(([key, config]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex items-center gap-2">
                      <config.icon className="h-4 w-4" />
                      {config.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Status Tabs */}
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)} className="mb-6">
          <TabsList className="bg-[var(--bg-tertiary)]">
            <TabsTrigger value="all" className="data-[state=active]:bg-[var(--bg-secondary)]">
              全部 ({statusCounts.all})
            </TabsTrigger>
            <TabsTrigger value="open" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <AlertCircle className="h-4 w-4 mr-1 text-amber-400" />
              待处理 ({statusCounts.open})
            </TabsTrigger>
            <TabsTrigger value="in_progress" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <Clock className="h-4 w-4 mr-1 text-blue-400" />
              处理中 ({statusCounts.in_progress})
            </TabsTrigger>
            <TabsTrigger value="closed" className="data-[state=active]:bg-[var(--bg-secondary)]">
              <CheckCircle className="h-4 w-4 mr-1 text-emerald-400" />
              已关闭 ({statusCounts.closed})
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Tickets Table */}
        <Card
          data-testid="admin-tickets-table-card"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}
        >
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">工单ID</TableHead>
                  <TableHead>工单标题</TableHead>
                  <TableHead>提交用户</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>回复数</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket: Ticket) => {
                  const statusInfo = statusConfig[ticket.status];
                  const categoryInfo = categoryConfig[ticket.category || 'other'];
                  const priorityInfo = priorityConfig[ticket.priority || 'medium'];
                  const StatusIcon = statusInfo.icon;
                  const CategoryIcon = categoryInfo.icon;
                  const PriorityIcon = priorityInfo.icon;
                  return (
                    <TableRow key={ticket.id} data-testid={`admin-ticket-row-${ticket.id}`}>
                      {/* Ticket ID */}
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => copyTicketId(ticket.id)}
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs font-mono hover:bg-[var(--bg-tertiary)] transition-colors"
                              style={{ color: 'var(--text-tertiary)' }}
                            >
                              #{formatShortId(ticket.id)}
                              {copiedId === ticket.id ? (
                                <CheckCheck className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3 opacity-50" />
                              )}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>点击复制完整ID</p>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      {/* Title */}
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <div
                            className="p-2 rounded-lg"
                            style={{ background: 'var(--bg-tertiary)' }}
                          >
                            <Headphones className="h-4 w-4 text-[var(--text-tertiary)]" />
                          </div>
                          <div>
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                              {ticket.title}
                            </p>
                            <p className="text-sm truncate max-w-[250px]" style={{ color: 'var(--text-tertiary)' }}>
                              {ticket.description || '无描述'}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      {/* User */}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarImage src={ticket.user?.avatar_url || undefined} />
                            <AvatarFallback className="text-xs bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                              {getAvatarFallback(ticket.user)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                            {getUserDisplayName(ticket.user)}
                          </span>
                        </div>
                      </TableCell>
                      {/* Category */}
                      <TableCell>
                        <Badge className={`${categoryInfo.color} border-0`}>
                          <CategoryIcon className="h-3 w-3 mr-1" />
                          {categoryInfo.label}
                        </Badge>
                      </TableCell>
                      {/* Priority */}
                      <TableCell>
                        <Badge className={`${priorityInfo.color} border-0`}>
                          <PriorityIcon className="h-3 w-3 mr-1" />
                          {priorityInfo.label}
                        </Badge>
                      </TableCell>
                      {/* Status */}
                      <TableCell>
                        <Badge className={`${statusInfo.color} border`}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {statusInfo.label}
                        </Badge>
                      </TableCell>
                      {/* Replies */}
                      <TableCell>
                        <div className="flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                          <MessageSquare className="h-4 w-4" />
                          <span>{ticket.ticket_replies?.length || 0}</span>
                        </div>
                      </TableCell>
                      {/* Created At */}
                      <TableCell style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(ticket.created_at).toLocaleDateString('zh-CN')}
                      </TableCell>
                      {/* Actions */}
                      <TableCell>
                        <Button
                          data-testid={`admin-ticket-open-${ticket.id}`}
                          variant="outline"
                          size="sm"
                          onClick={() => openTicketDetail(ticket)}
                          className="border-[var(--border-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {tickets.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
                      暂无工单
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Ticket Detail Sheet */}
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          data-testid="admin-ticket-detail-sheet"
          className="w-[600px] sm:max-w-[600px] overflow-y-auto"
          style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
        >
            <SheetHeader>
              <SheetTitle style={{ color: 'var(--text-primary)' }}>工单详情</SheetTitle>
            </SheetHeader>

            {selectedTicket && (
              <div className="mt-6 space-y-6">
                {/* Ticket ID and Meta */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="font-mono text-[var(--text-tertiary)] border-[var(--border-primary)]">
                      #{formatShortId(selectedTicket.id)}
                    </Badge>
                    <button
                      onClick={() => copyTicketId(selectedTicket.id)}
                      className="p-1 hover:bg-[var(--bg-tertiary)] rounded"
                    >
                      {copiedId === selectedTicket.id ? (
                        <CheckCheck className="h-4 w-4 text-emerald-400" />
                      ) : (
                        <Copy className="h-4 w-4 text-[var(--text-tertiary)]" />
                      )}
                    </button>
                  </div>
                  {/* Quick Mark Resolved Button */}
                  {selectedTicket.status !== 'closed' && (
                    <Button
                      data-testid="admin-ticket-mark-resolved"
                      size="sm"
                      onClick={handleMarkResolved}
                      disabled={updateStatus.isPending}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      标记已解决
                    </Button>
                  )}
                </div>

                {/* User Info Card */}
                <Card style={{ background: 'var(--bg-tertiary)', border: 'none' }}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      提交用户
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10">
                        <AvatarImage src={selectedTicket.user?.avatar_url || undefined} />
                        <AvatarFallback className="bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                          {getAvatarFallback(selectedTicket.user)}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                          {getUserDisplayName(selectedTicket.user)}
                        </p>
                        <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                          {selectedTicket.user?.email || '无邮箱'}
                        </p>
                      </div>
                      {selectedTicket.user?.role === 'admin' && (
                        <Badge className="ml-auto bg-purple-500/20 text-purple-400 border-0">
                          <Shield className="h-3 w-3 mr-1" />
                          管理员
                        </Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>

                {/* Ticket Info */}
                <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                  <CardContent className="pt-4 space-y-4">
                    <div>
                      <h3 className="font-semibold text-lg" style={{ color: 'var(--text-primary)' }}>
                        {selectedTicket.title}
                      </h3>
                      <div className="flex items-center gap-2 mt-2">
                        <Badge className={`${categoryConfig[selectedTicket.category || 'other'].color} border-0`}>
                          {(() => {
                            const CategoryIcon = categoryConfig[selectedTicket.category || 'other'].icon;
                            return <CategoryIcon className="h-3 w-3 mr-1" />;
                          })()}
                          {categoryConfig[selectedTicket.category || 'other'].label}
                        </Badge>
                        <Badge className={`${priorityConfig[selectedTicket.priority || 'medium'].color} border-0`}>
                          {(() => {
                            const PriorityIcon = priorityConfig[selectedTicket.priority || 'medium'].icon;
                            return <PriorityIcon className="h-3 w-3 mr-1" />;
                          })()}
                          优先级: {priorityConfig[selectedTicket.priority || 'medium'].label}
                        </Badge>
                      </div>
                    </div>

                    {/* Description */}
                    <div>
                      <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                        问题描述
                      </h4>
                      <div
                        className="p-4 rounded-lg text-sm whitespace-pre-wrap"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                      >
                        {selectedTicket.description || '无描述内容'}
                      </div>
                    </div>

                    {/* Attachments */}
                    {selectedTicket.attachments && selectedTicket.attachments.length > 0 && (
                      <div>
                        <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                          附件 ({selectedTicket.attachments.length})
                        </h4>
                        <div className="grid grid-cols-3 gap-2">
                          {selectedTicket.attachments.map((url: string, index: number) => (
                            <a
                              key={index}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group relative rounded-lg overflow-hidden border border-[var(--border-primary)] hover:border-[var(--color-primary)] transition-colors"
                            >
                              <TicketAttachmentTile url={url} index={index} />
                              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <Download className="h-5 w-5 text-white" />
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Time Info */}
                    <div className="flex items-center justify-between pt-2 text-xs" style={{ color: 'var(--text-disabled)' }}>
                      <span>创建于 {new Date(selectedTicket.created_at).toLocaleString('zh-CN')}</span>
                      <span>更新于 {new Date(selectedTicket.updated_at).toLocaleString('zh-CN')}</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Status Control */}
                <div className="space-y-2">
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    工单状态
                  </label>
                  <Select
                    value={selectedTicket.status}
                    onValueChange={(value) => handleStatusChange(selectedTicket.id, value as TicketStatus)}
                  >
                    <SelectTrigger data-testid="admin-ticket-status-select" className="bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="open">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 text-amber-400" />
                          待处理
                        </div>
                      </SelectItem>
                      <SelectItem value="in_progress">
                        <div className="flex items-center gap-2">
                          <Clock className="h-4 w-4 text-blue-400" />
                          处理中
                        </div>
                      </SelectItem>
                      <SelectItem value="closed">
                        <div className="flex items-center gap-2">
                          <CheckCircle className="h-4 w-4 text-emerald-400" />
                          已关闭
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Replies */}
                <div className="space-y-3">
                  <h4 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    回复记录 ({selectedTicket.ticket_replies?.length || 0})
                  </h4>
                  <div className="space-y-3 max-h-[400px] overflow-y-auto">
                    {selectedTicket.ticket_replies?.map((reply: TicketReply) => {
                      const isAdmin = reply.is_admin === 'true' || reply.user?.role === 'admin';
                      return (
                        <div
                          key={reply.id}
                          className={`p-4 rounded-lg ${isAdmin ? 'border-l-4 border-l-purple-500' : 'border-l-4 border-l-blue-500'}`}
                          style={{ background: 'var(--bg-tertiary)' }}
                        >
                          {/* Reply Header */}
                          <div className="flex items-center gap-2 mb-2">
                            <Avatar className="h-6 w-6">
                              <AvatarImage src={reply.user?.avatar_url || undefined} />
                              <AvatarFallback className="text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                                {getAvatarFallback(reply.user)}
                              </AvatarFallback>
                            </Avatar>
                            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                              {getUserDisplayName(reply.user)}
                            </span>
                            {isAdmin ? (
                              <Badge className="bg-purple-500/20 text-purple-400 border-0 text-xs">
                                <Shield className="h-3 w-3 mr-1" />
                                管理员
                              </Badge>
                            ) : (
                              <Badge className="bg-blue-500/20 text-blue-400 border-0 text-xs">
                                <User className="h-3 w-3 mr-1" />
                                用户
                              </Badge>
                            )}
                            <span className="ml-auto text-xs" style={{ color: 'var(--text-disabled)' }}>
                              {new Date(reply.created_at).toLocaleString('zh-CN')}
                            </span>
                          </div>
                          {/* Reply Content */}
                          <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                            {reply.content}
                          </p>
                          {/* Reply Attachments */}
                          {reply.attachments && reply.attachments.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {reply.attachments.map((url: string, index: number) => (
                                <a
                                  key={index}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--bg-secondary)] text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                                >
                                  <FileText className="h-3 w-3" />
                                  附件 {index + 1}
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {(!selectedTicket.ticket_replies || selectedTicket.ticket_replies.length === 0) && (
                      <p className="text-sm text-center py-4" style={{ color: 'var(--text-disabled)' }}>
                        暂无回复
                      </p>
                    )}
                  </div>
                </div>

                {/* Reply Input */}
                {selectedTicket.status !== 'closed' && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                      发送回复 (以管理员身份)
                    </h4>
                    <Textarea
                      data-testid="admin-ticket-reply-input"
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder="输入回复内容..."
                      className="min-h-[100px] bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
                    />
                    <Button
                      data-testid="admin-ticket-reply-submit"
                      onClick={handleReply}
                      disabled={!replyContent.trim() || replyMutation.isPending}
                      className="w-full bg-[var(--color-primary)] text-black hover:bg-[var(--color-primary)]/90"
                    >
                      <Send className="h-4 w-4 mr-2" />
                      {replyMutation.isPending ? '发送中...' : '发送回复'}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  );
}
