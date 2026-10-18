/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  communityText, formatDay, pendingRemovalRows, stateText, type FounderOverviewRow,
} from './founderAdminView';

type Mark = (row: FounderOverviewRow, action: 'joined' | 'removed') => void;

export function FounderMemberRow({ row, pending, onMark }: { row: FounderOverviewRow; pending: boolean; onMark: Mark }) {
  const joined = Boolean(row.community.joinedAt) && !row.community.removedAt;
  return <div className="space-y-1 border-b py-3 last:border-b-0" data-testid={`founder-member-${row.userId}`}>
    <p className="font-medium">{row.email ?? '（无邮箱）'}{!row.accountOpen && <span className="ml-2 text-sm text-muted-foreground">账号已关闭</span>}</p>
    <p className="text-sm text-muted-foreground">
      编号 {row.userId.slice(0, 8)}；成为创始会员：{formatDay(row.foundedAt) ?? '—'}；状态：{stateText(row)}
      {row.founder.state === 'ended' && row.founder.endedAt ? `（${formatDay(row.founder.endedAt)}）` : ''}
    </p>
    <p className="text-sm">社群：{communityText(row)}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending || joined}
        onClick={() => onMark(row, 'joined')} data-testid={`founder-member-${row.userId}-joined`}>标记已入群</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || !row.community.joinedAt || Boolean(row.community.removedAt)}
        onClick={() => onMark(row, 'removed')} data-testid={`founder-member-${row.userId}-removed`}>标记已移出</Button>
    </div>
  </div>;
}

export function FounderMembersPanel({ rows, pending, onMark }: { rows: FounderOverviewRow[]; pending: boolean; onMark: Mark }) {
  const toRemove = pendingRemovalRows(rows);
  return <>
    <Card data-testid="founder-pending-removal">
      <CardHeader>
        <CardTitle>待移出社群（{toRemove.length}）</CardTitle>
        <CardDescription>身份已结束、已标记入群、还没标记移出的会员。拒付冻结中属于临时状态，不会出现在这里。建议结束后 7 天内移出。</CardDescription>
      </CardHeader>
      <CardContent>
        {toRemove.length === 0 ? <p data-testid="founder-pending-empty">目前没有需要移出的人。</p>
          : toRemove.map(row => <FounderMemberRow key={row.userId} row={row} pending={pending} onMark={onMark} />)}
      </CardContent>
    </Card>
    <Card data-testid="founder-members">
      <CardHeader>
        <CardTitle>创始会员名单（{rows.length}）</CardTitle>
        <CardDescription>在社群里办理入群或移出后，回到这里手动标记。邮箱只在后台显示。</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? <p data-testid="founder-members-empty">还没有创始会员。</p>
          : rows.map(row => <FounderMemberRow key={row.userId} row={row} pending={pending} onMark={onMark} />)}
      </CardContent>
    </Card>
  </>;
}
