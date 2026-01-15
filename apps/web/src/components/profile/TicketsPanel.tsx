'use client';

import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus, AlertCircle, Inbox, Archive, ArrowLeft, Loader2,
  CheckCircle, Clock, Send, Upload, X
} from 'lucide-react';

interface MockUser {
  email?: string;
}

interface Ticket {
  id: string;
  ticket_number: string;
  title: string;
  description: string;
  category: string;
  status: 'pending' | 'in_progress' | 'resolved' | 'closed';
  created_date: string;
}

interface TicketReply {
  id: string;
  message: string;
  is_admin_reply: boolean;
  created_date: string;
}

const categoryOptions = [
  { value: 'technical_support', label: '技术支持' },
  { value: 'feature_request', label: '功能建议' },
  { value: 'bug_report', label: 'Bug反馈' },
  { value: 'account_issue', label: '账户问题' },
  { value: 'other', label: '其他' },
];

const statusLabels: Record<string, string> = {
  pending: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭'
};

const statusColors: Record<string, { bg: string; color: string; border: string }> = {
  pending: { bg: 'rgba(234, 179, 8, 0.1)', color: '#EAB308', border: 'rgba(234, 179, 8, 0.3)' },
  in_progress: { bg: 'rgba(59, 130, 246, 0.1)', color: '#3B82F6', border: 'rgba(59, 130, 246, 0.3)' },
  resolved: { bg: 'rgba(34, 197, 94, 0.1)', color: '#22C55E', border: 'rgba(34, 197, 94, 0.3)' },
  closed: { bg: 'rgba(107, 114, 128, 0.1)', color: '#6B7280', border: 'rgba(107, 114, 128, 0.3)' }
};

const categoryMap: Record<string, string> = {
  technical_support: '技术支持',
  feature_request: '功能建议',
  bug_report: 'Bug反馈',
  account_issue: '账户问题',
  other: '其他'
};

// 工单列表视图
const TicketListView = memo(function TicketListView({
  tickets,
  isLoading,
  onSelectTicket,
  onCreateNew
}: {
  tickets: Ticket[];
  isLoading: boolean;
  onSelectTicket: (ticket: Ticket) => void;
  onCreateNew: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'active' | 'closed'>('active');

  const activeTickets = tickets.filter(t => t.status !== 'closed');
  const closedTickets = tickets.filter(t => t.status === 'closed');
  const displayTickets = activeTab === 'active' ? activeTickets : closedTickets;

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>我的工单</h3>
        <Button
          onClick={onCreateNew}
          size="sm"
          className="gap-2"
          style={{
            background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
            color: 'var(--bg-primary)'
          }}
        >
          <Plus className="h-4 w-4" />
          创建工单
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setActiveTab('active')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
          style={{
            background: activeTab === 'active' ? 'rgba(255, 215, 0, 0.1)' : 'transparent',
            color: activeTab === 'active' ? 'var(--color-primary)' : 'var(--text-secondary)',
            border: activeTab === 'active' ? '1px solid rgba(255, 215, 0, 0.2)' : '1px solid transparent'
          }}
        >
          <Inbox className="h-4 w-4" />
          现有工单
          {activeTickets.length > 0 && (
            <span
              className="px-2 py-0.5 text-xs rounded-full"
              style={{ background: 'rgba(255, 215, 0, 0.2)', color: 'var(--color-primary)' }}
            >
              {activeTickets.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('closed')}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
          style={{
            background: activeTab === 'closed' ? 'rgba(255, 215, 0, 0.1)' : 'transparent',
            color: activeTab === 'closed' ? 'var(--color-primary)' : 'var(--text-secondary)',
            border: activeTab === 'closed' ? '1px solid rgba(255, 215, 0, 0.2)' : '1px solid transparent'
          }}
        >
          <Archive className="h-4 w-4" />
          已关闭
          {closedTickets.length > 0 && (
            <span
              className="px-2 py-0.5 text-xs rounded-full"
              style={{ background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' }}
            >
              {closedTickets.length}
            </span>
          )}
        </button>
      </div>

      {/* Ticket List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
        </div>
      ) : displayTickets.length === 0 ? (
        <div className="text-center py-12">
          <AlertCircle className="h-12 w-12 mx-auto mb-4" style={{ color: 'var(--text-tertiary)' }} />
          <p className="mb-2" style={{ color: 'var(--text-primary)' }}>
            {activeTab === 'active' ? '暂无现有工单' : '暂无已关闭工单'}
          </p>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {activeTab === 'active' ? '有问题？创建一个工单吧' : '关闭的工单会显示在这里'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {displayTickets.map((ticket) => {
            const statusStyle = statusColors[ticket.status] || statusColors.pending;
            const ticketDate = new Date(ticket.created_date);
            const dateStr = `${String(ticketDate.getMonth() + 1).padStart(2, '0')}-${String(ticketDate.getDate()).padStart(2, '0')} ${String(ticketDate.getHours()).padStart(2, '0')}:${String(ticketDate.getMinutes()).padStart(2, '0')}`;

            return (
              <div
                key={ticket.id}
                onClick={() => onSelectTicket(ticket)}
                className="p-4 rounded-xl cursor-pointer transition-all duration-200"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-primary)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255, 215, 0, 0.3)';
                  e.currentTarget.style.transform = 'translateX(4px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-primary)';
                  e.currentTarget.style.transform = 'translateX(0)';
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="text-xs font-mono" style={{ color: 'var(--text-tertiary)' }}>
                        {ticket.ticket_number}
                      </span>
                      <span
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{
                          background: statusStyle.bg,
                          color: statusStyle.color,
                          border: `1px solid ${statusStyle.border}`
                        }}
                      >
                        {statusLabels[ticket.status]}
                      </span>
                    </div>
                    <h4 className="font-medium mb-1 truncate" style={{ color: 'var(--text-primary)' }}>
                      {ticket.title}
                    </h4>
                    <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                      <span>{categoryMap[ticket.category]}</span>
                      <span>•</span>
                      <span>{dateStr}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

// 工单详情视图
const TicketDetailView = memo(function TicketDetailView({
  ticket,
  user,
  onBack,
  onTicketUpdate
}: {
  ticket: Ticket;
  user: MockUser;
  onBack: () => void;
  onTicketUpdate: () => void;
}) {
  const [replyMessage, setReplyMessage] = useState('');
  const [repliesLoading] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);

  // Mock replies
  const replies: TicketReply[] = [];

  const ticketDate = new Date(ticket.created_date);
  const dateStr = `${ticketDate.getFullYear()}-${String(ticketDate.getMonth() + 1).padStart(2, '0')}-${String(ticketDate.getDate()).padStart(2, '0')} ${String(ticketDate.getHours()).padStart(2, '0')}:${String(ticketDate.getMinutes()).padStart(2, '0')}`;

  const handleReplySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyMessage.trim()) return;
    setSendingReply(true);
    try {
      // TODO: Call tRPC to add reply
      console.log('Sending reply:', replyMessage);
      setTimeout(() => {
        setReplyMessage('');
        setSendingReply(false);
      }, 1000);
    } catch (error) {
      setSendingReply(false);
    }
  };

  const statusStyle = statusColors[ticket.status] || statusColors.pending;

  return (
    <div className="space-y-6">
      {/* Header with Back Button */}
      <div
        className="rounded-2xl p-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <Button
          variant="ghost"
          onClick={onBack}
          className="mb-4 -ml-2"
          style={{ color: 'var(--text-secondary)' }}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          返回工单列表
        </Button>

        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <span className="text-sm font-mono" style={{ color: 'var(--text-tertiary)' }}>
                {ticket.ticket_number}
              </span>
              <span
                className="text-xs px-2 py-0.5 rounded-full"
                style={{
                  background: statusStyle.bg,
                  color: statusStyle.color,
                  border: `1px solid ${statusStyle.border}`
                }}
              >
                {statusLabels[ticket.status]}
              </span>
            </div>
            <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              {ticket.title}
            </h2>
            <div className="flex items-center gap-3 text-sm flex-wrap" style={{ color: 'var(--text-tertiary)' }}>
              <span>{categoryMap[ticket.category]}</span>
              <span>•</span>
              <span>创建于 {dateStr}</span>
            </div>
          </div>
          {ticket.status === 'resolved' && (
            <Button
              onClick={() => {
                // TODO: Close ticket
                console.log('Closing ticket');
                onTicketUpdate();
              }}
              size="sm"
              style={{
                background: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)',
                color: 'white'
              }}
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              确认解决
            </Button>
          )}
        </div>

        <div className="pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>问题描述</h4>
          <p className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
            {ticket.description}
          </p>
        </div>
      </div>

      {/* Replies */}
      <div
        className="rounded-2xl p-6"
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <h3 className="text-lg font-bold mb-4" style={{ color: 'var(--text-primary)' }}>回复记录</h3>

        {/* 时效提醒 */}
        {ticket.status !== 'closed' && (
          <div
            className="flex items-center gap-2 p-3 rounded-lg mb-4"
            style={{
              background: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.2)'
            }}
          >
            <Clock className="h-4 w-4 shrink-0" style={{ color: '#3B82F6' }} />
            <span className="text-sm" style={{ color: '#3B82F6' }}>
              我们会在 48 小时内回复您的问题，通常会更快。
            </span>
          </div>
        )}

        {repliesLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : replies.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            暂无回复
          </div>
        ) : (
          <div className="space-y-4">
            {replies.map((reply) => {
              const replyDate = new Date(reply.created_date);
              const replyDateStr = `${String(replyDate.getMonth() + 1).padStart(2, '0')}-${String(replyDate.getDate()).padStart(2, '0')} ${String(replyDate.getHours()).padStart(2, '0')}:${String(replyDate.getMinutes()).padStart(2, '0')}`;

              return (
                <div
                  key={reply.id}
                  className="p-4 rounded-xl"
                  style={{
                    background: reply.is_admin_reply ? 'rgba(59, 130, 246, 0.05)' : 'var(--bg-primary)',
                    border: `1px solid ${reply.is_admin_reply ? 'rgba(59, 130, 246, 0.2)' : 'var(--border-primary)'}`
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-xs px-2 py-0.5 rounded-full"
                      style={{
                        background: reply.is_admin_reply ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 215, 0, 0.1)',
                        color: reply.is_admin_reply ? '#3B82F6' : 'var(--color-primary)'
                      }}
                    >
                      {reply.is_admin_reply ? '客服回复' : '我的回复'}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--text-disabled)' }}>
                      {replyDateStr}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
                    {reply.message}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        {/* Reply Form */}
        {ticket.status !== 'closed' && (
          <form onSubmit={handleReplySubmit} className="mt-6 pt-6" style={{ borderTop: '1px solid var(--border-primary)' }}>
            <Textarea
              placeholder="输入您的回复..."
              value={replyMessage}
              onChange={(e) => setReplyMessage(e.target.value)}
              className="mb-3 min-h-[100px]"
              style={{
                background: 'var(--bg-primary)',
                borderColor: 'var(--border-primary)',
                color: 'var(--text-primary)'
              }}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={sendingReply || !replyMessage.trim()}
                className="gap-2"
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  color: 'var(--bg-primary)'
                }}
              >
                {sendingReply ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                发送回复
              </Button>
            </div>
          </form>
        )}

        {ticket.status === 'closed' && (
          <div
            className="mt-6 p-4 rounded-xl text-center"
            style={{
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)'
            }}
          >
            <CheckCircle className="h-8 w-8 mx-auto mb-2" style={{ color: 'var(--text-tertiary)' }} />
            <p style={{ color: 'var(--text-secondary)' }}>此工单已关闭</p>
          </div>
        )}
      </div>
    </div>
  );
});

// 创建工单表单
const CreateTicketForm = memo(function CreateTicketForm({
  user,
  onBack,
  onSuccess
}: {
  user: MockUser;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    category: 'technical_support'
  });
  const [attachments, setAttachments] = useState<{ name: string; url: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          continue;
        }
        if (file.size > 5 * 1024 * 1024) {
          continue;
        }
        // TODO: Upload file via tRPC
        // Mock upload
        setAttachments(prev => [...prev, { name: file.name, url: URL.createObjectURL(file) }]);
      }
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.title.trim() || !formData.description.trim()) {
      return;
    }
    setCreating(true);
    try {
      // TODO: Create ticket via tRPC
      console.log('Creating ticket:', formData);
      setTimeout(() => {
        onSuccess();
        setCreating(false);
      }, 1000);
    } catch (error) {
      setCreating(false);
    }
  };

  return (
    <div
      className="rounded-2xl p-6"
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
      }}
    >
      <Button
        variant="ghost"
        onClick={onBack}
        className="mb-4 -ml-2"
        style={{ color: 'var(--text-secondary)' }}
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        返回工单列表
      </Button>

      <h3 className="text-lg font-bold mb-6" style={{ color: 'var(--text-primary)' }}>创建新工单</h3>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            标题 <span style={{ color: 'var(--error)' }}>*</span>
          </label>
          <Input
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            placeholder="简要描述您的问题"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)'
            }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            分类
          </label>
          <Select value={formData.category} onValueChange={(v) => setFormData({ ...formData, category: v })}>
            <SelectTrigger style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)', color: 'var(--text-primary)' }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categoryOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            问题描述 <span style={{ color: 'var(--error)' }}>*</span>
          </label>
          <Textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder="请详细描述您遇到的问题..."
            className="min-h-[150px]"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-primary)'
            }}
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            附件截图
          </label>
          <div
            className="p-4 rounded-xl border-2 border-dashed transition-colors"
            style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-primary)' }}
          >
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileUpload}
              className="hidden"
              id="ticket-attachment"
              disabled={uploading}
            />
            <label
              htmlFor="ticket-attachment"
              className="flex flex-col items-center justify-center cursor-pointer py-4"
            >
              {uploading ? (
                <Loader2 className="h-8 w-8 animate-spin mb-2" style={{ color: 'var(--color-primary)' }} />
              ) : (
                <Upload className="h-8 w-8 mb-2" style={{ color: 'var(--text-tertiary)' }} />
              )}
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {uploading ? '上传中...' : '点击上传截图（支持多张）'}
              </span>
              <span className="text-xs mt-1" style={{ color: 'var(--text-disabled)' }}>
                支持 JPG、PNG 格式，单张不超过 5MB
              </span>
            </label>
          </div>

          {attachments.length > 0 && (
            <div className="mt-3 space-y-2">
              {attachments.map((att, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg"
                  style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-primary)' }}
                >
                  <div className="flex items-center gap-3">
                    <img src={att.url} alt={att.name} loading="lazy" className="w-12 h-12 object-cover rounded" />
                    <span className="text-sm truncate max-w-[200px]" style={{ color: 'var(--text-primary)' }}>
                      {att.name}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAttachment(index)}
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            style={{
              background: 'transparent',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)'
            }}
          >
            取消
          </Button>
          <Button
            type="submit"
            disabled={creating}
            className="gap-2"
            style={{
              background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
              color: 'var(--bg-primary)'
            }}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            提交工单
          </Button>
        </div>
      </form>
    </div>
  );
});

// 主组件
export default function TicketsPanel({
  user,
  initialView = 'list',
  onViewChange
}: {
  user: MockUser;
  initialView?: 'list' | 'detail' | 'create';
  onViewChange?: (view: string) => void;
}) {
  const [view, setView] = useState<'list' | 'detail' | 'create'>(initialView);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [isLoading] = useState(false);

  // 使用空数组展示空状态（根据截图要求）
  const tickets: Ticket[] = [];

  const changeView = (newView: 'list' | 'detail' | 'create') => {
    setView(newView);
    onViewChange?.(newView);
  };

  const handleSelectTicket = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    changeView('detail');
  };

  const handleBack = () => {
    changeView('list');
    setSelectedTicket(null);
  };

  const handleCreateNew = () => {
    changeView('create');
  };

  const handleCreateSuccess = () => {
    changeView('list');
  };

  if (view === 'create') {
    return <CreateTicketForm user={user} onBack={handleBack} onSuccess={handleCreateSuccess} />;
  }

  if (view === 'detail' && selectedTicket) {
    return (
      <TicketDetailView
        ticket={selectedTicket}
        user={user}
        onBack={handleBack}
        onTicketUpdate={() => {
          handleBack();
        }}
      />
    );
  }

  return (
    <TicketListView
      tickets={tickets}
      isLoading={isLoading}
      onSelectTicket={handleSelectTicket}
      onCreateNew={handleCreateNew}
    />
  );
}
