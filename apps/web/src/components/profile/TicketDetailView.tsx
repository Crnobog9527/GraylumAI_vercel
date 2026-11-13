'use client';

import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ArrowLeft, Loader2, CheckCircle, Clock, Send, Image as ImageIcon } from 'lucide-react';
import { trpc } from '@/trpc/client';
import { statusLabels, statusColors, categoryMap, type MockUser, type Ticket } from './ticketsShared';
// Phones only (639px and below): the app-style layout of the ticket pages; a computer is unchanged.
import phone from './tickets-phone.module.css';

// 工单详情视图
export const TicketDetailView = memo(function TicketDetailView({
  ticket,
  onBack,
  onTicketUpdate
}: {
  ticket: Ticket;
  user: MockUser;
  onBack: () => void;
  onTicketUpdate: () => void;
}) {
  const [replyMessage, setReplyMessage] = useState('');

  // tRPC mutations
  const replyMutation = trpc.ticket.replyToTicket.useMutation({
    onSuccess: () => {
      setReplyMessage('');
      onTicketUpdate();
    },
  });

  const closeMutation = trpc.ticket.closeTicket.useMutation({
    onSuccess: () => {
      onTicketUpdate();
      onBack();
    },
  });

  const replies = ticket.replies || [];

  const ticketDate = new Date(ticket.created_date);
  const dateStr = `${ticketDate.getFullYear()}-${String(ticketDate.getMonth() + 1).padStart(2, '0')}-${String(ticketDate.getDate()).padStart(2, '0')} `
    + `${String(ticketDate.getHours()).padStart(2, '0')}:${String(ticketDate.getMinutes()).padStart(2, '0')}`;

  const handleReplySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyMessage.trim()) return;
    replyMutation.mutate({ ticketId: ticket.id, content: replyMessage.trim() });
  };

  const handleCloseTicket = () => {
    closeMutation.mutate({ ticketId: ticket.id });
  };

  const statusStyle = statusColors[ticket.status] || statusColors.pending;

  return (
    <div className="space-y-6" data-testid="ticket-detail-view">
      {/* Header with Back Button */}
      <div
        className={`rounded-2xl p-6 ${phone.card}`}
        style={{
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.2)'
        }}
      >
        <Button
          variant="ghost"
          onClick={onBack}
          className={`mb-4 -ml-2 ${phone.back}`}
          style={{ color: 'var(--text-secondary)' }}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          返回工单列表
        </Button>

        <div className={`flex items-start justify-between gap-4 mb-4 ${phone.detailHead}`}>
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
              <span>{categoryMap[ticket.category] || ticket.category}</span>
              <span>•</span>
              <span>创建于 {dateStr}</span>
            </div>
          </div>
          {ticket.status !== 'closed' && (
            <Button
              onClick={handleCloseTicket}
              disabled={closeMutation.isPending}
              size="sm"
              className={phone.closeTicket}
              style={{
                background: 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)',
                color: 'white'
              }}
            >
              {closeMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <CheckCircle className="h-4 w-4 mr-2" />
              )}
              关闭工单
            </Button>
          )}
        </div>

        <div className="pt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
          <h4 className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>问题描述</h4>
          <p className="whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
            {ticket.description}
          </p>
        </div>

        {/* 附件显示 */}
        {ticket.attachments && ticket.attachments.length > 0 && (
          <div className="pt-4 mt-4" style={{ borderTop: '1px solid var(--border-primary)' }}>
            <h4 className="text-sm font-medium mb-3 flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
              <ImageIcon className="h-4 w-4" />
              附件截图 ({ticket.attachments.length})
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {ticket.attachments.map((url, index) => (
                <a
                  key={index}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block rounded-lg overflow-hidden border transition-all hover:border-yellow-500/50"
                  style={{ borderColor: 'var(--border-primary)' }}
                >
                  <img
                    src={url}
                    alt={`附件 ${index + 1}`}
                    className="w-full h-32 object-cover"
                    loading="lazy"
                  />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Replies */}
      <div
        className={`rounded-2xl p-6 ${phone.card}`}
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
            <Clock className="h-4 w-4 shrink-0" style={{ color: 'var(--info)' }} />
            <span className="text-sm" style={{ color: 'var(--info)' }}>
              我们会在 48 小时内回复您的问题，通常会更快。
            </span>
          </div>
        )}

        {replies.length === 0 ? (
          <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
            暂无回复
          </div>
        ) : (
          <div className="space-y-4">
            {replies.map((reply) => {
              const replyDate = new Date(reply.created_date);
              const replyDateStr = `${String(replyDate.getMonth() + 1).padStart(2, '0')}-${String(replyDate.getDate()).padStart(2, '0')} `
                + `${String(replyDate.getHours()).padStart(2, '0')}:${String(replyDate.getMinutes()).padStart(2, '0')}`;

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
                        color: reply.is_admin_reply ? 'var(--info)' : 'var(--color-primary)'
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
                  {reply.attachments && reply.attachments.length > 0 && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                      {reply.attachments.map((url, index) => (
                        <a
                          key={index}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-lg overflow-hidden border transition-all hover:border-yellow-500/50"
                          style={{ borderColor: 'var(--border-primary)' }}
                        >
                          <img
                            src={url}
                            alt={`回复附件 ${index + 1}`}
                            className="w-full h-32 object-cover"
                            loading="lazy"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Reply Form */}
        {ticket.status !== 'closed' && (
          <form onSubmit={handleReplySubmit} className={`mt-6 pt-6 ${phone.reply}`} style={{ borderTop: '1px solid var(--border-primary)' }}>
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
                disabled={replyMutation.isPending || !replyMessage.trim()}
                className={`gap-2 ${phone.send}`}
                style={{
                  background: 'linear-gradient(135deg, var(--color-primary) 0%, var(--color-secondary) 100%)',
                  color: 'var(--bg-primary)'
                }}
              >
                {replyMutation.isPending ? (
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
