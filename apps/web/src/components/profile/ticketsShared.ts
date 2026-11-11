/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Types, labels and colours shared by the support-ticket views (TicketsPanel and its three views).

export interface MockUser {
  email?: string;
}

export interface Ticket {
  id: string;
  ticket_number: string;
  title: string;
  description: string;
  category: string;
  status: 'pending' | 'in_progress' | 'resolved' | 'closed';
  created_date: string;
  attachments?: string[];
  replies?: TicketReply[];
}

export interface TicketReply {
  id: string;
  message: string;
  is_admin_reply: boolean;
  attachments?: string[];
  created_date: string;
}

export const categoryOptions = [
  { value: 'technical_support', label: '技术支持' },
  { value: 'feature_request', label: '功能建议' },
  { value: 'bug_report', label: 'Bug反馈' },
  { value: 'account_issue', label: '账户问题' }, { value: 'billing', label: '账单/退款' },
  { value: 'other', label: '其他' },
];

export const statusLabels: Record<string, string> = {
  pending: '待处理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭'
};

export const statusColors: Record<string, { bg: string; color: string; border: string }> = {
  pending: { bg: 'var(--warning-bg)', color: 'var(--warning)', border: 'var(--warning)' },
  in_progress: { bg: 'var(--info-bg)', color: 'var(--info)', border: 'var(--info)' },
  resolved: { bg: 'var(--success-bg)', color: 'var(--success)', border: 'var(--success)' },
  closed: { bg: 'rgba(107, 114, 128, 0.1)', color: 'var(--text-secondary)', border: 'var(--border-secondary)' }
};

export const categoryMap: Record<string, string> = {
  technical_support: '技术支持',
  feature_request: '功能建议',
  bug_report: 'Bug反馈',
  account_issue: '账户问题', billing: '账单/退款', expert_consult: '专家诊断预约',
  other: '其他'
};
