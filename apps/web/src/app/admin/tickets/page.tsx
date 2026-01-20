'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import {
  Headphones, MessageSquare, Clock, CheckCircle,
  AlertCircle, Send, ChevronRight
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import AdminSidebar from '@/components/admin/AdminSidebar';

type TicketStatus = 'open' | 'in_progress' | 'closed';

interface TicketReply {
  id: string;
  content: string;
  user_id: string;
  created_at: string;
}

interface Ticket {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  ticket_replies: TicketReply[];
}

const statusConfig: Record<TicketStatus, { label: string; color: string; icon: React.ElementType }> = {
  open: { label: '待处理', color: 'bg-amber-500/20 text-amber-400', icon: AlertCircle },
  in_progress: { label: '处理中', color: 'bg-blue-500/20 text-blue-400', icon: Clock },
  closed: { label: '已关闭', color: 'bg-emerald-500/20 text-emerald-400', icon: CheckCircle },
};

export default function AdminTicketsPage() {
  const [statusFilter, setStatusFilter] = useState<TicketStatus | 'all'>('all');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [replyContent, setReplyContent] = useState('');

  const { data, isLoading, error, refetch } = trpc.admin.getAllTickets.useQuery({
    status: statusFilter === 'all' ? undefined : statusFilter,
  });
  const tickets = data?.tickets ?? [];

  const updateStatus = trpc.admin.updateTicketStatus.useMutation({
    onSuccess: () => {
      refetch();
      // Update selected ticket if it's open
      if (selectedTicket) {
        const updated = tickets.find(t => t.id === selectedTicket.id);
        if (updated) setSelectedTicket(updated);
      }
    }
  });

  const replyMutation = trpc.admin.replyToTicket.useMutation({
    onSuccess: () => {
      refetch();
      setReplyContent('');
      // Refresh selected ticket data
      if (selectedTicket) {
        const updated = tickets.find(t => t.id === selectedTicket.id);
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

  const openTicketDetail = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setSheetOpen(true);
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

  // Count tickets by status
  const statusCounts = {
    all: data?.total ?? 0,
    open: tickets.filter(t => t.status === 'open').length,
    in_progress: tickets.filter(t => t.status === 'in_progress').length,
    closed: tickets.filter(t => t.status === 'closed').length,
  };

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg-primary)' }}>
      <AdminSidebar />

      <div className="flex-1 p-8 overflow-auto">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: 'var(--text-primary)' }}>
              工单管理
            </h1>
            <p className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
              处理用户反馈和支持请求
            </p>
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
        <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>工单标题</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>回复数</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket: Ticket) => {
                  const statusInfo = statusConfig[ticket.status];
                  const StatusIcon = statusInfo.icon;
                  return (
                    <TableRow key={ticket.id}>
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
                            <p className="text-sm truncate max-w-[300px]" style={{ color: 'var(--text-tertiary)' }}>
                              {ticket.description}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={statusInfo.color}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {statusInfo.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                          <MessageSquare className="h-4 w-4" />
                          <span>{ticket.ticket_replies?.length || 0}</span>
                        </div>
                      </TableCell>
                      <TableCell style={{ color: 'var(--text-tertiary)' }}>
                        {new Date(ticket.created_at).toLocaleDateString('zh-CN')}
                      </TableCell>
                      <TableCell>
                        <Button
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
                    <TableCell colSpan={5} className="text-center py-12" style={{ color: 'var(--text-disabled)' }}>
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
            className="w-[500px] sm:max-w-[500px] overflow-y-auto"
            style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
          >
            <SheetHeader>
              <SheetTitle style={{ color: 'var(--text-primary)' }}>工单详情</SheetTitle>
            </SheetHeader>

            {selectedTicket && (
              <div className="mt-6 space-y-6">
                {/* Ticket Info */}
                <div
                  className="p-4 rounded-lg space-y-3"
                  style={{ background: 'var(--bg-secondary)' }}
                >
                  <h3 className="font-semibold text-lg" style={{ color: 'var(--text-primary)' }}>
                    {selectedTicket.title}
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    {selectedTicket.description}
                  </p>
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      创建于 {new Date(selectedTicket.created_at).toLocaleString('zh-CN')}
                    </span>
                  </div>
                </div>

                {/* Status Control */}
                <div className="space-y-2">
                  <label className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    工单状态
                  </label>
                  <Select
                    value={selectedTicket.status}
                    onValueChange={(value) => handleStatusChange(selectedTicket.id, value as TicketStatus)}
                  >
                    <SelectTrigger className="bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
                      <SelectItem value="open">待处理</SelectItem>
                      <SelectItem value="in_progress">处理中</SelectItem>
                      <SelectItem value="closed">已关闭</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Replies */}
                <div className="space-y-3">
                  <h4 className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                    回复记录 ({selectedTicket.ticket_replies?.length || 0})
                  </h4>
                  <div className="space-y-3 max-h-[300px] overflow-y-auto">
                    {selectedTicket.ticket_replies?.map((reply: TicketReply) => (
                      <div
                        key={reply.id}
                        className="p-3 rounded-lg"
                        style={{ background: 'var(--bg-tertiary)' }}
                      >
                        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
                          {reply.content}
                        </p>
                        <p className="text-xs mt-2" style={{ color: 'var(--text-disabled)' }}>
                          {new Date(reply.created_at).toLocaleString('zh-CN')}
                        </p>
                      </div>
                    ))}
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
                      发送回复
                    </h4>
                    <Textarea
                      value={replyContent}
                      onChange={(e) => setReplyContent(e.target.value)}
                      placeholder="输入回复内容..."
                      className="min-h-[100px] bg-[var(--bg-secondary)] border-[var(--border-primary)] text-[var(--text-primary)] placeholder:text-[var(--text-disabled)]"
                    />
                    <Button
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
    </div>
  );
}
