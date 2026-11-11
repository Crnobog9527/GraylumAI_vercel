'use client';

import { useState, useMemo } from 'react';
import { trpc } from '@/trpc/client';
import { type MockUser, type Ticket } from './ticketsShared';
import { TicketListView } from './TicketListView';
import { TicketDetailView } from './TicketDetailView';
import { CreateTicketForm } from './CreateTicketForm';

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
  // Which half of the list is showing. It lives here, not in the list, because the list is unmounted while a ticket
  // or the form is open: coming back has to land on the half the user left.
  const [listTab, setListTab] = useState<'active' | 'closed'>('active');

  // 从 API 获取工单列表
  const { data: ticketsData, isLoading, error, refetch } = trpc.ticket.getTickets.useQuery();

  // 转换 API 数据为组件所需格式
  const tickets: Ticket[] = useMemo(() => {
    if (!ticketsData) return [];
    return ticketsData.map((t: any) => ({
      id: t.id,
      ticket_number: t.ticket_number,
      title: t.title,
      description: t.description || '',
      category: t.category,
      status: t.status as Ticket['status'],
      created_date: t.created_at,
      attachments: t.attachments || [],
      replies: t.replies?.map((r: any) => ({
        id: r.id,
        message: r.message,
        is_admin_reply: r.is_admin_reply,
        attachments: r.attachments || [],
        created_date: r.created_at,
      })) || [],
    }));
  }, [ticketsData]);

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

  const handleCreateSuccess = async () => {
    await refetch();
    setListTab('active'); // a new ticket is an open one: show the half it is in
    changeView('list');
  };

  const handleTicketUpdate = () => {
    refetch();
  };

  if (view === 'create') {
    return <CreateTicketForm user={user} onBack={handleBack} onSuccess={handleCreateSuccess} />;
  }

  if (view === 'detail' && selectedTicket) {
    // Find the latest ticket data from the list
    const latestTicket = tickets.find(t => t.id === selectedTicket.id) || selectedTicket;
    return (
      <TicketDetailView
        ticket={latestTicket}
        user={user}
        onBack={handleBack}
        onTicketUpdate={handleTicketUpdate}
      />
    );
  }

  return (
    <TicketListView
      tickets={tickets}
      isLoading={isLoading}
      errorMessage={error?.message ?? null}
      onRetry={() => {
        void refetch();
      }}
      onSelectTicket={handleSelectTicket}
      onCreateNew={handleCreateNew}
      activeTab={listTab}
      onTabChange={setListTab}
    />
  );
}
