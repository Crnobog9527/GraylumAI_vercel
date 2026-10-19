/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PLATFORM_LABEL, REVIEW_LABEL, type FounderOverviewRow } from './founderAdminView';

type Review = (row: FounderOverviewRow, decision: 'approved' | 'rejected') => void;

export function FounderWallCard({ row, pending, onReview }: { row: FounderOverviewRow; pending: boolean; onReview: Review }) {
  const wall = row.wall;
  if (!wall) return null;
  return <div className="space-y-1 border-b py-3 last:border-b-0" data-testid={`founder-wall-${row.userId}`}>
    <p className="font-medium">{wall.displayName}<span className="ml-2 text-sm text-muted-foreground">{row.email ?? ''}</span></p>
    <p className="text-sm">
      {REVIEW_LABEL[wall.reviewState]}
      {!wall.consented && '；会员已撤回公开同意'}
      {wall.reviewState === 'approved' && !wall.listed && '；当前不在墙上（身份已结束、冻结或已撤回）'}
    </p>
    {wall.socialAccounts.map(item => <p key={item.url} className="text-sm text-muted-foreground">
      {PLATFORM_LABEL[item.platform] ?? item.platform}：{item.handle}（{item.url}）
    </p>)}
    {wall.productName && <p className="text-sm text-muted-foreground">产品：{wall.productName}{wall.productUrl ? `（${wall.productUrl}）` : ''}</p>}
    {wall.intro && <p className="text-sm">{wall.intro}</p>}
    {wall.consented && <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={pending || wall.reviewState === 'approved'}
        onClick={() => onReview(row, 'approved')} data-testid={`founder-wall-${row.userId}-approve`}>通过</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending || wall.reviewState === 'rejected'}
        onClick={() => onReview(row, 'rejected')} data-testid={`founder-wall-${row.userId}-reject`}>拒绝</Button>
    </div>}
  </div>;
}

export function FounderWallReviewPanel({ rows, pending, onReview }: { rows: FounderOverviewRow[]; pending: boolean; onReview: Review }) {
  const withWall = rows.filter(row => row.wall);
  const queued = withWall.filter(row => row.wall?.consented && row.wall.reviewState === 'pending').length;
  return <Card data-testid="founder-wall-review">
    <CardHeader>
      <CardTitle>展示墙审核（待审 {queued}）</CardTitle>
      <CardDescription>会员本人勾选“愿意公开”后才会出现在这里。通过后才显示在公开墙；会员修改内容后会重新变成待审。</CardDescription>
    </CardHeader>
    <CardContent>
      {withWall.length === 0 ? <p data-testid="founder-wall-empty">还没有会员提交展示卡。</p>
        : withWall.map(row => <FounderWallCard key={row.userId} row={row} pending={pending} onReview={onReview} />)}
    </CardContent>
  </Card>;
}
