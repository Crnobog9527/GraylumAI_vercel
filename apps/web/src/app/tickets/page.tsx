'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export default function TicketsPage() {
  const { data: tickets, isLoading, refetch } = trpc.ticket.getTickets.useQuery();
  const createTicketMutation = trpc.ticket.createTicket.useMutation({
    onSuccess: () => {
      refetch();
      setNewTicketTitle('');
      setNewTicketContent('');
      setShowForm(false);
    },
  });

  const [newTicketTitle, setNewTicketTitle] = useState('');
  const [newTicketContent, setNewTicketContent] = useState('');
  const [showForm, setShowForm] = useState(false);

  const handleCreateTicket = () => {
    if (newTicketTitle.trim() && newTicketContent.trim()) {
      createTicketMutation.mutate({ title: newTicketTitle, content: newTicketContent });
    }
  };

  if (isLoading) return <div className="container mx-auto p-4">Loading tickets...</div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">My Tickets</h1>
        <Button onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Cancel' : 'Create New Ticket'}
        </Button>
      </div>

      {showForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Create New Ticket</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <Input
                placeholder="Ticket Title (min 5 characters)"
                value={newTicketTitle}
                onChange={(e) => setNewTicketTitle(e.target.value)}
              />
              <Textarea
                placeholder="Ticket Content (min 10 characters)"
                value={newTicketContent}
                onChange={(e) => setNewTicketContent(e.target.value)}
              />
              <Button
                onClick={handleCreateTicket}
                disabled={createTicketMutation.isPending || newTicketTitle.length < 5 || newTicketContent.length < 10}
              >
                {createTicketMutation.isPending ? 'Submitting...' : 'Submit Ticket'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {tickets && tickets.length > 0 ? (
          tickets.map((ticket: { id: string; title: string; status: string; createdAt: string; ticket_replies?: { content: string }[] }) => (
            <Card key={ticket.id}>
              <CardHeader>
                <CardTitle>
                  {ticket.title} - <span className="text-sm text-gray-500">Status: {ticket.status}</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700">Created at: {new Date(ticket.createdAt).toLocaleString()}</p>
                {ticket.ticket_replies?.[0]?.content && (
                  <p className="mt-2">{ticket.ticket_replies[0].content}</p>
                )}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-gray-500">No tickets yet. Create your first ticket!</p>
        )}
      </div>
    </div>
  );
}
