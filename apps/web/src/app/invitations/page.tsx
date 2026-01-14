'use client';

import { trpc } from '@/trpc/client';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface Invitation {
  code: string;
  createdBy: string;
  usedBy: string | null;
  status: string;
  createdAt: string;
}

export default function InvitationsPage() {
  const { data: invitations, isLoading, refetch } = trpc.invitation.getInvitationHistory.useQuery();
  const generateInvitationMutation = trpc.invitation.generateInvitationCode.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  if (isLoading) return <div className="container mx-auto p-4">Loading invitations...</div>;

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-2xl font-bold">Invitation Management</h1>
        <Button
          onClick={() => generateInvitationMutation.mutate()}
          disabled={generateInvitationMutation.isPending}
        >
          {generateInvitationMutation.isPending ? 'Generating...' : 'Generate New Code'}
        </Button>
      </div>

      <div className="grid gap-4">
        {invitations && invitations.length > 0 ? (
          invitations.map((invite: Invitation) => (
            <Card key={invite.code}>
              <CardHeader>
                <CardTitle className="font-mono">Code: {invite.code}</CardTitle>
              </CardHeader>
              <CardContent>
                <p>Created By: {invite.createdBy}</p>
                <p>Used By: {invite.usedBy || 'N/A'}</p>
                <p>Status: <span className={invite.status === 'active' ? 'text-green-600' : 'text-gray-500'}>{invite.status}</span></p>
                <p>Created At: {new Date(invite.createdAt).toLocaleString()}</p>
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-gray-500">No invitation codes yet. Generate your first code!</p>
        )}
      </div>
    </div>
  );
}
