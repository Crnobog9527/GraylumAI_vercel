'use client';

import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, AlertCircle, Inbox, Archive, Loader2 } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { statusLabels, statusColors, categoryMap, type Ticket } from './ticketsShared';

// 工单列表视图
export const TicketListView = memo(function TicketListView({
  tickets,
  isLoading,
  errorMessage,
  onRetry,
  onSelectTicket,
  onCreateNew,
  activeTab,
  onTabChange: setActiveTab
}: {
  tickets: Ticket[];
  isLoading: boolean;
  errorMessage?: string | null;
  onRetry: () => void;
  onSelectTicket: (ticket: Ticket) => void;
  onCreateNew: () => void;
  /** 现有工单 or 已关闭. Owned by TicketsPanel so it survives opening a ticket and coming back. */
  activeTab: 'active' | 'closed';
  onTabChange: (tab: 'active' | 'closed') => void;
}) {
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
          data-testid="ticket-create-button"
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
          className={'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium '
            + 'transition-[background-color,border-color,color] duration-200 motion-reduce:transition-none'}
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
          className={'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium '
            + 'transition-[background-color,border-color,color] duration-200 motion-reduce:transition-none'}
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
        <PageSkeleton compact rows={4} label="工单读取中" />
      ) : errorMessage ? (
        <div className="text-center py-12">
          <AlertCircle className="h-12 w-12 mx-auto mb-4" style={{ color: 'var(--error)' }} />
          <p className="mb-2" style={{ color: 'var(--text-primary)' }}>
            工单暂时加载失败
          </p>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            {errorMessage}
          </p>
          <Button
            variant="outline"
            onClick={onRetry}
            className="gap-2"
            style={{
              background: 'var(--bg-primary)',
              borderColor: 'var(--border-primary)',
              color: 'var(--text-secondary)',
            }}
          >
            <Loader2 className="h-4 w-4" />
            重新加载
          </Button>
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
            const dateStr = `${String(ticketDate.getMonth() + 1).padStart(2, '0')}-${String(ticketDate.getDate()).padStart(2, '0')} `
              + `${String(ticketDate.getHours()).padStart(2, '0')}:${String(ticketDate.getMinutes()).padStart(2, '0')}`;

            return (
              <div
                key={ticket.id}
                data-testid="ticket-list-item"
                onClick={() => onSelectTicket(ticket)}
                // The border is a class, not an inline style: an inline border would override the hover colour.
                className={'p-4 rounded-xl cursor-pointer transition-[border-color,transform,box-shadow] duration-200 '
                  + 'motion-reduce:transition-none border border-[var(--border-primary)] hover:translate-x-1 '
                  + 'hover:border-[rgba(255,215,0,0.3)] hover:shadow-[0_8px_24px_rgba(0,0,0,0.18)]'}
                style={{ background: 'var(--bg-primary)' }}
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
                      <span>{categoryMap[ticket.category] || ticket.category}</span>
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
