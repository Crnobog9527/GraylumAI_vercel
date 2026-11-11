/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adminRouter } from './admin';

// The admin router is assembled from the sibling ./admin*.ts files. This is the list the web calls as `admin.<name>`:
// a procedure that goes missing in a move, or a new name that shadows an existing one, fails here.
const PROCEDURES = [
  // adminUsers, adminUserMembership
  'adjustUserCredits', 'getAllUsers', 'getUserActivityLogs', 'getUserDetails', 'searchUsers', 'updateUserMembership',
  'updateUserRole', 'updateUserStatus',
  // adminModules (feature modules, under the legacy "prompts" names)
  'batchDeletePrompts', 'batchSetPromptActive', 'batchUpdatePrompts', 'createPrompt', 'getPromptsDashboard', 'removePrompt',
  'removePrompts', 'updatePrompt',
  // adminAnnouncements, adminPackages, adminTickets, adminTransactions
  'createAnnouncement', 'deleteAnnouncement', 'getAllAnnouncements', 'updateAnnouncement',
  'createPackage', 'deletePackage', 'getPackagesDashboard', 'updatePackage',
  'getAllTickets', 'replyToTicket', 'updateTicketStatus', 'getAllTransactions',
  // adminDashboardStats, adminFinanceStats, adminPerformanceStats, adminSettingsDashboard
  'getStatistics', 'getFinanceStats', 'getPerformanceStats', 'getSettingsDashboard',
  // adminRefunds, adminMembershipPlans
  'approveMonthlyRefund', 'decidePackageRefund', 'executeMonthlyRefund', 'executePackageRefund', 'getMonthlyRefundStatus',
  'getPackageRefundStatus', 'previewPackageRefund', 'previewSubscriptionRefund', 'quoteMonthlyRefund', 'reconcilePackageRefund',
  'rejectMonthlyRefund', 'rejectPackageRefund', 'resolveRefundTicket',
  // Deep review item 14: externally refunded packs held for a person (list, settle).
  'listPackRefundReviews', 'settlePackRefundReview',
  'approveSubscriptionRefund', 'executeSubscriptionRefund', 'getSubscriptionRefundStatus', 'quoteSubscriptionRefund',
  'rejectSubscriptionRefund',
  'createMembershipPlan', 'deleteMembershipPlan', 'updateMembershipPlan',
];

describe('admin router', () => {
  it('serves exactly the known procedures, each once', () => {
    expect(new Set(PROCEDURES).size).toBe(PROCEDURES.length);
    expect(Object.keys(adminRouter._def.procedures).sort()).toEqual([...PROCEDURES].sort());
  });
});
