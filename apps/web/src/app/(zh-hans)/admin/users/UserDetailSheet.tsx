/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { Coins, Clock, MessageSquare, History, AlertTriangle, Activity, Mail, Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { adminUserContact } from '@/lib/adminUserContact';
import { RoleBadge } from '@/components/ui/status-badge';
import { formatLastLogin } from './lastLogin';
import { statusConfig, membershipConfig, type UserStatus, type MembershipLevel, type ActivityLog } from './usersShared';
import type { UsersAdmin } from './useUsersAdmin';

// 用户详情侧栏：资料、使用统计、操作日志。从 page.tsx 原样搬出。
export function UserDetailSheet({ admin }: { admin: UsersAdmin }) {
  const {
    detailSheetOpen, setDetailSheetOpen, userDetails, isLoadingDetails,
  } = admin;

  return (
    <Sheet open={detailSheetOpen} onOpenChange={setDetailSheetOpen}>
      <SheetContent className="w-[500px] sm:max-w-[500px] overflow-y-auto" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-primary)' }}>
        <SheetHeader>
          <SheetTitle style={{ color: 'var(--text-primary)' }}>用户详情</SheetTitle>
        </SheetHeader>

        {isLoadingDetails ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[var(--color-primary)]" />
          </div>
        ) : userDetails ? (
          <div className="mt-6 space-y-6">
            {/* User Profile Card */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardContent className="pt-6">
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={userDetails.profile.avatar_url || undefined} />
                    <AvatarFallback className="text-xl bg-[var(--color-primary-20)] text-[var(--color-primary)]">
                      {userDetails.profile.nickname?.[0] || userDetails.profile.email?.[0]?.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {userDetails.profile.nickname || '未设置昵称'}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <Mail className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                      <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        {adminUserContact(userDetails.profile)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <RoleBadge role={userDetails.profile.role} />
                      <Badge className={`${statusConfig[userDetails.profile.status as UserStatus || 'active'].color} flex items-center gap-1`}>
                        {(() => {
                          const StatusIcon = statusConfig[userDetails.profile.status as UserStatus || 'active'].icon;
                          return <StatusIcon className="h-3 w-3 flex-shrink-0" />;
                        })()}
                        <span>{statusConfig[userDetails.profile.status as UserStatus || 'active'].label}</span>
                      </Badge>
                      <Badge className={`${membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].color} flex items-center gap-1`}>
                        {(() => {
                          const MemberIcon = membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].icon;
                          return <MemberIcon className="h-3 w-3 flex-shrink-0" />;
                        })()}
                        <span>{membershipConfig[userDetails.profile.membership_level as MembershipLevel || 'free'].label}</span>
                      </Badge>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 mt-6">
                  <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>注册时间</span>
                    </div>
                    <p className="mt-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {new Date(userDetails.profile.created_at).toLocaleDateString('zh-CN')}
                    </p>
                  </div>
                  <div className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <div className="flex items-center gap-2">
                      <Clock className="h-4 w-4" style={{ color: 'var(--text-tertiary)' }} />
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>最后登录</span>
                    </div>
                    <p className="mt-1 text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {formatLastLogin(userDetails.profile)}
                    </p>
                  </div>
                </div>

                {userDetails.profile.last_ip && (
                  <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>最后登录 IP</span>
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                      {userDetails.profile.last_ip}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Usage Statistics */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <Activity className="h-4 w-4" />
                  使用统计
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <MessageSquare className="h-6 w-6 mx-auto mb-2 text-blue-400" />
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {userDetails.stats.totalConversations}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>对话数</p>
                  </div>
                  <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <Coins className="h-6 w-6 mx-auto mb-2 text-amber-400" />
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {userDetails.stats.totalCreditsSpent.toLocaleString()}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>消耗积分</p>
                  </div>
                  <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <Coins className="h-6 w-6 mx-auto mb-2 text-emerald-400" />
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {(userDetails.profile.credits || 0).toLocaleString()}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>当前余额</p>
                  </div>
                  <div className="text-center p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                    <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-purple-400" />
                    <p className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
                      {userDetails.stats.totalTickets}
                    </p>
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>工单数</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Recent Activity */}
            <Card style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                  <History className="h-4 w-4" />
                  操作日志
                </CardTitle>
              </CardHeader>
              <CardContent>
                {userDetails.recentActivity.length > 0 ? (
                  <div className="space-y-3">
                    {userDetails.recentActivity.map((log: ActivityLog) => (
                      <div key={log.id} className="flex items-start gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)' }}>
                        <div className="flex-1">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {log.action}
                          </p>
                          <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {new Date(log.created_at).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        <Badge className="text-xs bg-slate-500/20 text-slate-400">
                          {log.action_type}
                        </Badge>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8" style={{ color: 'var(--text-disabled)' }}>
                    暂无操作日志
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
