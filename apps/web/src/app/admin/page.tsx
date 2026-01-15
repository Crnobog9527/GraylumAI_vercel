'use client';

import { trpc } from '@/trpc/client';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useState } from 'react';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  role: string;
  credits: number;
  created_at: string;
}

export default function AdminDashboardPage() {
  const { data: stats, isLoading, error, refetch } = trpc.admin.getStatistics.useQuery();
  const [selectedTab, setSelectedTab] = useState<'overview' | 'users' | 'tickets'>('overview');

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Admin Dashboard</h1>
        <p>Loading statistics...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">Admin Dashboard</h1>
        <Card className="bg-red-50 border-red-200">
          <CardContent className="pt-6">
            <p className="text-red-600">
              {error.message === 'You do not have permission to access this resource. Admin role required.'
                ? 'Access Denied: You need admin privileges to view this page.'
                : `Error: ${error.message}`}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <Button onClick={() => refetch()} variant="outline">
          Refresh
        </Button>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-2 mb-6">
        <Button
          variant={selectedTab === 'overview' ? 'default' : 'outline'}
          onClick={() => setSelectedTab('overview')}
        >
          Overview
        </Button>
        <Button
          variant={selectedTab === 'users' ? 'default' : 'outline'}
          onClick={() => setSelectedTab('users')}
        >
          Recent Users
        </Button>
        <Button
          variant={selectedTab === 'tickets' ? 'default' : 'outline'}
          onClick={() => setSelectedTab('tickets')}
        >
          Quick Links
        </Button>
      </div>

      {selectedTab === 'overview' && (
        <>
          {/* Statistics Cards */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-6">
            {/* Users Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Total Users</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stats?.users.total ?? 0}</p>
              </CardContent>
            </Card>

            {/* Credits Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Total Credits</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold">{stats?.credits.totalInSystem.toLocaleString() ?? 0}</p>
              </CardContent>
            </Card>

            {/* Tickets Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Open Tickets</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-orange-600">{stats?.tickets.open ?? 0}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {stats?.tickets.inProgress ?? 0} in progress / {stats?.tickets.total ?? 0} total
                </p>
              </CardContent>
            </Card>

            {/* Invitations Card */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-gray-500">Active Invitations</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-green-600">{stats?.invitations.active ?? 0}</p>
                <p className="text-xs text-gray-500 mt-1">
                  {stats?.invitations.used ?? 0} used / {stats?.invitations.total ?? 0} total
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Detailed Breakdown */}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Tickets Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Tickets Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>Open</span>
                    <span className="font-medium text-orange-600">{stats?.tickets.open ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>In Progress</span>
                    <span className="font-medium text-blue-600">{stats?.tickets.inProgress ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Closed</span>
                    <span className="font-medium text-green-600">{stats?.tickets.closed ?? 0}</span>
                  </div>
                  <hr className="my-2" />
                  <div className="flex justify-between font-bold">
                    <span>Total</span>
                    <span>{stats?.tickets.total ?? 0}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Invitations Breakdown */}
            <Card>
              <CardHeader>
                <CardTitle>Invitations Overview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>Active</span>
                    <span className="font-medium text-green-600">{stats?.invitations.active ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Used</span>
                    <span className="font-medium text-blue-600">{stats?.invitations.used ?? 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Expired</span>
                    <span className="font-medium text-gray-500">{stats?.invitations.expired ?? 0}</span>
                  </div>
                  <hr className="my-2" />
                  <div className="flex justify-between font-bold">
                    <span>Total</span>
                    <span>{stats?.invitations.total ?? 0}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {selectedTab === 'users' && (
        <Card>
          <CardHeader>
            <CardTitle>Recent Users</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.users.recentUsers && stats.users.recentUsers.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-2">Email</th>
                      <th className="text-left py-2 px-2">Nickname</th>
                      <th className="text-left py-2 px-2">Role</th>
                      <th className="text-right py-2 px-2">Credits</th>
                      <th className="text-left py-2 px-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.users.recentUsers.map((user: User) => (
                      <tr key={user.id} className="border-b hover:bg-gray-50">
                        <td className="py-2 px-2">{user.email}</td>
                        <td className="py-2 px-2">{user.nickname || '-'}</td>
                        <td className="py-2 px-2">
                          <span className={`px-2 py-1 rounded text-xs ${
                            user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-gray-100 text-gray-800'
                          }`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-right">{user.credits}</td>
                        <td className="py-2 px-2 text-gray-500">
                          {new Date(user.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-gray-500">No users found.</p>
            )}
          </CardContent>
        </Card>
      )}

      {selectedTab === 'tickets' && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <CardTitle className="text-lg">Manage Invitations</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">Generate new invitation codes and view history.</p>
              <Button onClick={() => window.location.href = '/invitations'} className="w-full">
                Go to Invitations
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <CardTitle className="text-lg">AI Models</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">Configure and manage AI model settings.</p>
              <Button onClick={() => window.location.href = '/models'} className="w-full">
                Go to Models
              </Button>
            </CardContent>
          </Card>

          <Card className="hover:shadow-md transition-shadow">
            <CardHeader>
              <CardTitle className="text-lg">Support Tickets</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-600 mb-4">View and respond to user support tickets.</p>
              <Button onClick={() => window.location.href = '/tickets'} className="w-full">
                Go to Tickets
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
